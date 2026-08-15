import { test, expect } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

loadEnv({ path: ".env.local", quiet: true });

// Requires a live Supabase project and creates/deletes a real test user +
// organization, so it's opt-in the same way tests/security/* is -- never
// runs just because `npm run test:e2e` was invoked.
const runDbTests = process.env.RUN_DB_SECURITY_TESTS === "true";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

test.describe("customer + job creation flow", () => {
  test.skip(
    !runDbTests,
    "requires RUN_DB_SECURITY_TESTS=true and a live Supabase project",
  );

  let email: string;
  let password: string;
  let userId: string;
  let orgId: string | undefined;

  test.beforeAll(async () => {
    email = `tradeai-e2e-${randomUUID()}@example.invalid`;
    password = `Test-${randomUUID()}-!`;
    const admin = adminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw error ?? new Error("failed to create e2e test user");
    }
    userId = data.user.id;
  });

  test.afterAll(async () => {
    if (orgId) {
      const pool = new Pool({ connectionString: process.env.DIRECT_URL });
      await pool.query(
        `delete from public.jobs where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(
        `delete from public.customers where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(
        `delete from public.organization_memberships where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(`delete from public.organizations where id = $1::uuid`, [
        orgId,
      ]);
      await pool.end();
    }
    if (userId) {
      await adminClient().auth.admin.deleteUser(userId);
    }
  });

  test("log in, create an org, add a customer, create a job", async ({
    page,
  }) => {
    const orgName = `E2E Org ${randomUUID()}`;
    const customerName = `E2E Customer ${randomUUID()}`;
    const jobTitle = `E2E Job ${randomUUID()}`;

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(/\/orgs$/);

    await page.getByLabel("New organization name").fill(orgName);
    await page.getByRole("button", { name: "Create organization" }).click();

    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+$/);
    orgId = page.url().split("/orgs/")[1];

    await page.getByRole("link", { name: "Customers" }).click();
    await page.getByLabel("Name").fill(customerName);
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("link", { name: customerName })).toBeVisible();

    await page.getByRole("link", { name: "Jobs" }).click();
    await page.getByLabel("Title").fill(jobTitle);
    await page.getByRole("button", { name: "Create job" }).click();

    await expect(page.getByRole("heading", { name: jobTitle })).toBeVisible();
  });
});
