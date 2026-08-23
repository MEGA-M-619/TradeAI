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
  // Serial because the second test renders against the organization and job
  // the first one creates, and because the shared afterAll cleans up by
  // orgId. Without this, fullyParallel would race them across workers.
  test.describe.configure({ timeout: 120_000, mode: "serial" });

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

  /**
   * The model's stated limitations reach the technician's screen.
   *
   * Seeded straight into the database rather than produced by a model
   * call: this environment has no ANTHROPIC_API_KEY, so a completed
   * assessment cannot be generated here. What is exercised is everything
   * downstream of persistence -- the new column, the repository read, the
   * assessment detail API route, and the rendered UI -- which is exactly
   * the path that was silently dropping this field before.
   */
  test("a completed assessment shows the model's stated limitations to the technician", async ({
    page,
  }) => {
    const limitations = [
      "The neutral bar is out of frame in every photo",
      "The panel schedule label is not legible at this resolution",
    ];

    const pool = new Pool({ connectionString: process.env.DIRECT_URL });
    try {
      const jobs = await pool.query<{ id: string }>(
        `select id from public.jobs where organization_id = $1::uuid limit 1`,
        [orgId],
      );
      expect(jobs.rowCount).toBe(1);
      const jobId = jobs.rows[0].id;

      // Version 2, so this is the assessment the workspace shows (the
      // section renders the latest version, and version 1 is the failed
      // run from the test above).
      await pool.query(
        `insert into public.ai_assessment
           (organization_id, job_id, requested_by_user_id, version, status,
            model_id, prompt_version, schema_version, limitations,
            completed_at, updated_at)
         values ($1::uuid, $2::uuid, $3::uuid, 2, 'complete',
                 'claude-sonnet-5', 'test', 'test', $4, now(), now())`,
        [orgId, jobId, userId, limitations],
      );

      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Log in" }).click();
      // Only assert that login completed. Unlike the test above, this user
      // already belongs to an organization, so the app redirects past the
      // first-run /orgs page to that org's jobs list -- asserting any exact
      // intermediate URL here races the redirect chain.
      await expect(page).not.toHaveURL(/\/login$/);

      await page.goto(`/orgs/${orgId}/jobs/${jobId}`);
      await expect(page.getByText("Version 2")).toBeVisible();

      await expect(
        page.getByText("What this assessment could not determine"),
      ).toBeVisible();
      for (const limitation of limitations) {
        await expect(page.getByText(limitation)).toBeVisible();
      }
    } finally {
      await pool.end();
    }
  });

  /**
   * Phase 7D: safety warnings must render on insufficient_evidence, not
   * only on a completed assessment, and must render most-severe-first
   * regardless of the order they were written in. Seeded directly (as
   * the test above does) since the model call still cannot be exercised
   * here -- this proves the read/render path, not the model.
   */
  test("an insufficient_evidence assessment shows its safety warnings, most severe first", async ({
    page,
  }) => {
    const pool = new Pool({ connectionString: process.env.DIRECT_URL });
    try {
      const jobs = await pool.query<{ id: string }>(
        `select id from public.jobs where organization_id = $1::uuid limit 1`,
        [orgId],
      );
      expect(jobs.rowCount).toBe(1);
      const jobId = jobs.rows[0].id;

      // Version 3, so this becomes the latest and is what the workspace
      // shows.
      const assessment = await pool.query<{ id: string }>(
        `insert into public.ai_assessment
           (organization_id, job_id, requested_by_user_id, version, status,
            model_id, prompt_version, schema_version, insufficient_reason,
            completed_at, updated_at)
         values ($1::uuid, $2::uuid, $3::uuid, 3, 'insufficient_evidence',
                 'claude-sonnet-5', 'test', 'test', $4, now(), now())
         returning id`,
        [orgId, jobId, userId, "The panel label is not legible in any photo."],
      );
      const assessmentId = assessment.rows[0].id;

      // Inserted out of both severity and alphabetical order, so a
      // passing "most severe first" assertion below cannot be an
      // accident of insertion order.
      await pool.query(
        `insert into public.ai_assessment_safety_warning
           (assessment_id, organization_id, rule_id, severity, message)
         values
           ($1::uuid, $2::uuid, 'zz_advisory', 'advisory', 'Always de-energize and verify absence of voltage first.'),
           ($1::uuid, $2::uuid, 'mm_stop', 'stop_work', 'Possible arc fault indicators were noted.'),
           ($1::uuid, $2::uuid, 'bb_mandatory', 'mandatory', 'Possible missing bonding or grounding was noted.')`,
        [assessmentId, orgId],
      );

      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page).not.toHaveURL(/\/login$/);

      await page.goto(`/orgs/${orgId}/jobs/${jobId}`);
      await expect(page.getByText("Version 3")).toBeVisible();

      // Not hidden merely because the assessment did not complete.
      await expect(
        page.getByText("Not enough information in these photos"),
      ).toBeVisible();
      await expect(
        page.getByText("Possible arc fault indicators were noted."),
      ).toBeVisible();
      await expect(
        page.getByText("Possible missing bonding or grounding was noted."),
      ).toBeVisible();
      await expect(
        page.getByText("Always de-energize and verify absence of voltage first."),
      ).toBeVisible();

      // Rendered order follows severity -- stop_work, then mandatory, then
      // advisory -- not the insertion order or ruleId alphabetical order
      // used when writing the fixture above.
      const badges = await page
        .getByText(/^(Stop work|Mandatory|Advisory)$/)
        .allTextContents();
      expect(badges).toEqual(["Stop work", "Mandatory", "Advisory"]);
    } finally {
      await pool.end();
    }
  });
});
