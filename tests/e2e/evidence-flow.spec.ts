import { test, expect } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

loadEnv({ path: ".env.local", quiet: true });

// Same opt-in gate as tests/security/* -- creates a real user, org and
// Storage object against a live Supabase project.
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

test.describe("job evidence upload flow", () => {
  test.skip(!runDbTests, "requires RUN_DB_SECURITY_TESTS=true and a live Supabase project");

  // This walks the entire product in one test -- signup through org,
  // customer, job, a real Storage round trip and a delete -- against a
  // remote database, on top of cold Turbopack compiles for every route it
  // touches. The default 30s is not a meaningful budget for that.
  test.describe.configure({ timeout: 120_000 });

  let email: string;
  let password: string;
  let userId: string;
  let orgId: string | undefined;

  test.beforeAll(async () => {
    email = `tradeai-e2e-ev-${randomUUID()}@example.invalid`;
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
        await adminClient()
          .storage.from("job-evidence")
          .remove(objects.rows.map((r) => r.name));
      }
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

  test("add a photo to a job, see it, then delete it", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/orgs$/);

    await page.getByLabel("Business name").fill(`E2E Evidence ${randomUUID()}`);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/jobs$/);
    orgId = page.url().split("/orgs/")[1].split("/")[0];

    await page.getByRole("link", { name: "Customers", exact: true }).click();
    await page.getByRole("button", { name: "+ New Customer" }).click();
    await page.getByLabel("Name").fill("Evidence Customer");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("link", { name: "Evidence Customer" })).toBeVisible();

    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Panel inspection");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(page.getByRole("heading", { name: "Panel inspection" })).toBeVisible();

    // Empty state first.
    await expect(page.getByText("No photos yet")).toBeVisible();
    await expect(page.getByText("0 of 24")).toBeVisible();

    // The file input is visually hidden and driven by the "Add photos"
    // button; setInputFiles targets it directly.
    await page.locator('input[type="file"]').setInputFiles({
      name: "panel.png",
      mimeType: "image/png",
      buffer: PNG,
    });

    // Upload -> confirm -> refresh: the photo becomes visible and counted.
    await expect(page.getByRole("img", { name: "Job photo" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("1 of 24")).toBeVisible();
    await expect(page.getByText("No photos yet")).toHaveCount(0);

    // The row is only visible because it reached `ready`.
    const pool = new Pool({ connectionString: process.env.DIRECT_URL });
    const rows = await pool.query(
      `select upload_status, deleted_at, byte_size, client_sha256
         from public.evidence where organization_id = $1::uuid`,
      [orgId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].upload_status).toBe("ready");
    expect(rows.rows[0].deleted_at).toBeNull();
    expect(Number(rows.rows[0].byte_size)).toBeGreaterThan(0);
    expect(rows.rows[0].client_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Delete it: bytes go, tombstone stays. The tile's remove control and
    // the dialog's confirm button share an accessible name, so the confirm
    // click is scoped to the dialog rather than picked positionally.
    await page.getByRole("button", { name: "Delete photo" }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Delete photo" }).click();

    await expect(page.getByText("No photos yet")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("0 of 24")).toBeVisible();

    const afterDelete = await pool.query(
      `select upload_status, deleted_at, deleted_by_user_id
         from public.evidence where organization_id = $1::uuid`,
      [orgId],
    );
    expect(afterDelete.rowCount).toBe(1);
    expect(afterDelete.rows[0].deleted_at).not.toBeNull();
    expect(afterDelete.rows[0].deleted_by_user_id).toBe(userId);

    const objects = await pool.query(
      `select 1 from storage.objects where bucket_id = 'job-evidence' and name like $1`,
      [`${orgId}/%`],
    );
    expect(objects.rowCount).toBe(0);
    await pool.end();
  });
});
