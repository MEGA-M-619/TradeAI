import { test, expect } from "@playwright/test";

// Proves the app shell boots and the unauthenticated redirect works.
// Since Phase 1, "/" has no content of its own -- it's a server-side
// redirect (see app/page.tsx): unauthenticated -> /login,
// authenticated -> /orgs. This only exercises the unauthenticated path,
// which needs no live Supabase project; the authenticated path is
// covered by tests/e2e/customer-job-flow.spec.ts.
test("unauthenticated visitors are redirected from / to /login", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
});
