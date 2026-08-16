import { test, expect } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

loadEnv({ path: ".env.local", quiet: true });

const runDbTests = process.env.RUN_DB_SECURITY_TESTS === "true";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Exercises the full assessment pipeline through the real UI and real
 * HTTP routes: request -> queued -> the executor's real evidence fetch
 * and sha256 verification against a real Storage object -> a real
 * (failing) call attempt to the model port -> polling -> a rendered
 * terminal state.
 *
 * This environment has no ANTHROPIC_API_KEY configured, so the model call
 * itself cannot be exercised here -- that gap is real and is called out
 * in the final report, not hidden. What this test proves is everything
 * around it: creation, quota/evidence validation, the async+polling
 * contract, the executor's claim/fetch/verify steps, and that a model
 * failure surfaces as a clear "failed" state in the UI rather than a
 * silently stuck spinner. AnthropicAssessmentModel fails fast (no
 * ANTHROPIC_API_KEY -> throws before any network call), so this reaches
 * a terminal state quickly and deterministically.
 */
test.describe("job assessment request flow", () => {
  test.skip(!runDbTests, "requires RUN_DB_SECURITY_TESTS=true and a live Supabase project");
  test.describe.configure({ timeout: 120_000 });

  let email: string;
  let password: string;
  let userId: string;
  let orgId: string | undefined;

  test.beforeAll(async () => {
    email = `tradeai-e2e-assess-${randomUUID()}@example.invalid`;
    password = `Test-${randomUUID()}-!`;
    const { data, error } = await adminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("could not create test user");
    userId = data.user.id;
  });

  test.afterAll(async () => {
    const pool = new Pool({ connectionString: process.env.DIRECT_URL });
    if (orgId) {
      const objects = await pool.query(
        `select name from storage.objects where bucket_id = 'job-evidence' and name like $1`,
        [`${orgId}/%`],
      );
      if (objects.rowCount) {
        await adminClient().storage.from("job-evidence").remove(objects.rows.map((r) => r.name));
      }
      await pool.query(`delete from public.technician_verdict where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_citation where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_test where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_question where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_safety_warning where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_finding where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment_input where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_usage_ledger where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.ai_assessment where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.evidence where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.jobs where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.customers where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.organization_memberships where organization_id = $1::uuid`, [orgId]);
      await pool.query(`delete from public.organizations where id = $1::uuid`, [orgId]);
    }
    await pool.query(`delete from public.users where id = $1::uuid`, [userId]);
    await pool.end();
    await adminClient().auth.admin.deleteUser(userId);
  });

  test("request an assessment, watch it move from queued to a terminal state", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/orgs$/);

    await page.getByLabel("Business name").fill(`E2E Assessment ${randomUUID()}`);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/jobs$/);
    orgId = page.url().split("/orgs/")[1].split("/")[0];

    await page.getByRole("link", { name: "Customers", exact: true }).click();
    await page.getByRole("button", { name: "+ New Customer" }).click();
    await page.getByLabel("Name").fill("Assessment Customer");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("link", { name: "Assessment Customer" })).toBeVisible();

    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Assessment test job");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(page.getByRole("heading", { name: "Assessment test job" })).toBeVisible();

    // No evidence yet -> the request button is disabled and no picker is
    // reachable.
    await expect(page.getByRole("button", { name: "Request assessment" })).toBeDisabled();

    await page.locator('input[type="file"]').setInputFiles({
      name: "panel.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await expect(page.getByRole("img", { name: "Job photo" })).toBeVisible({ timeout: 20_000 });

    // Now the assessment picker is usable.
    await expect(page.getByRole("button", { name: "Request assessment" })).toBeEnabled();
    await page.getByRole("button", { name: "Request assessment" }).click();
    await expect(page.getByText(/Choose up to \d+ photos/)).toBeVisible();

    // Select the one photo we have.
    await page.locator('[aria-pressed]').first().click();
    await expect(page.getByText("1 of 8 selected")).toBeVisible();

    const submitButton = page.getByRole("button", { name: "Request assessment" }).last();
    await submitButton.click();

    // The picker closes and the assessment card appears with a version
    // label -- this alone proves creation succeeded (evidence validated,
    // quota checked, a queued row written, 201 returned).
    await expect(page.getByText("Version 1")).toBeVisible({ timeout: 20_000 });

    // It should reach a terminal state (queued -> running -> failed here,
    // since there is no ANTHROPIC_API_KEY in this environment) via
    // polling, without the test driving anything further.
    await expect(page.getByText("Assessment could not be completed")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("The assessment service could not be reached. Try again in a moment."),
    ).toBeVisible();

    // Confirm server-side state matches what the UI is showing.
    const pool = new Pool({ connectionString: process.env.DIRECT_URL });
    const rows = await pool.query(
      `select status, failure_category from public.ai_assessment where organization_id = $1::uuid`,
      [orgId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe("failed");
    expect(rows.rows[0].failure_category).toBe("model_error");

    // The input snapshot must still have been written (fetch+verify
    // happens before the model call) -- proves the executor got that far
    // rather than failing at evidence lookup.
    const inputRows = await pool.query(
      `select sha256_verified from public.ai_assessment_input where organization_id = $1::uuid`,
      [orgId],
    );
    expect(inputRows.rowCount).toBe(1);
    expect(inputRows.rows[0].sha256_verified).toMatch(/^[0-9a-f]{64}$/);
    await pool.end();
  });
});
