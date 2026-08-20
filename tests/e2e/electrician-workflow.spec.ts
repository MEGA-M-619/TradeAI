import { test, expect as baseExpect } from "@playwright/test";

/**
 * This spec walks the whole product against a remote Postgres, where a
 * single page render legitimately takes several seconds (six tenant-scoped
 * reads, each a round trip). The 10s default assertion budget in
 * playwright.config.ts is sized for a local database and is simply too
 * tight here -- it fails on latency rather than on behaviour.
 */
const expect = baseExpect.configure({ timeout: 30_000 });
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

loadEnv({ path: ".env.local", quiet: true });

// Same opt-in gate as the other live-DB specs.
const runDbTests = process.env.RUN_DB_SECURITY_TESTS === "true";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Phase 5: the end-to-end electrician workflow, driven entirely through
 * the UI -- no direct API calls, no database manipulation. This is the
 * test that answers "can an electrician actually use this?", which the
 * Phase 3B API spec deliberately did not.
 *
 * Walks: log in -> org -> customer -> job -> record a reading against a
 * circuit -> read the evaluation -> start an investigation -> read the
 * safety verdict -> add a cause -> confirm it -> see the state change.
 */
test.describe("electrician workflow", () => {
  test.skip(
    !runDbTests,
    "requires RUN_DB_SECURITY_TESTS=true and a live Supabase project",
  );

  // Serial: the later tests reuse the organization the first one creates,
  // so running them in parallel would navigate to /orgs/undefined and
  // fail for a reason that has nothing to do with what they assert.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let email: string;
  let password: string;
  let userId: string;
  let orgId: string | undefined;

  test.beforeAll(async () => {
    email = `tradeai-e2e-flow-${randomUUID()}@example.invalid`;
    password = `Test-${randomUUID()}-!`;
    const { data, error } = await adminClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("could not create user");
    userId = data.user.id;
  });

  test.afterAll(async () => {
    if (orgId) {
      const pool = new Pool({ connectionString: process.env.DIRECT_URL });
      for (const table of [
        "diagnostic_candidate_causes",
        "diagnostic_sessions",
        "measurements",
        "circuits",
        "jobs",
        "customers",
        "organization_memberships",
      ]) {
        await pool.query(
          `delete from public.${table} where organization_id = $1::uuid`,
          [orgId],
        );
      }
      await pool.query(`delete from public.organizations where id = $1::uuid`, [
        orgId,
      ]);
      await pool.end();
    }
    if (userId) await adminClient().auth.admin.deleteUser(userId);
  });

  test("record a reading, investigate, read the safety verdict, confirm a cause", async ({
    page,
  }) => {
    // --- Log in and set up the job context.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/orgs$/);

    await page.getByLabel("Business name").fill(`E2E Flow ${randomUUID()}`);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/jobs$/);
    orgId = page.url().split("/orgs/")[1].split("/")[0];

    await page.getByRole("link", { name: "Customers", exact: true }).click();
    await page.getByRole("button", { name: "+ New Customer" }).click();
    await page.getByLabel("Name").fill("Workflow Customer");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(
      page.getByRole("link", { name: "Workflow Customer" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Breaker keeps tripping");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "Breaker keeps tripping" }),
    ).toBeVisible();

    // --- The two new Phase 5 sections are present on the job page.
    await expect(
      page.getByRole("heading", { name: "Measurements" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Diagnosis & safety" }),
    ).toBeVisible();
    await expect(page.getByText("No readings yet")).toBeVisible();

    // --- Add a circuit and record a reading against it.
    await page.getByRole("button", { name: "Record reading" }).click();
    await page.getByLabel("Add a circuit").fill("Kitchen ring");
    await page.getByRole("button", { name: "Add circuit" }).click();
    await expect(page.getByText('Circuit "Kitchen ring" added')).toBeVisible();

    await page.getByLabel("Test type").selectOption("voltage_ac");
    await page.getByLabel("Reading").fill("228");
    await page.getByLabel("Expected minimum").fill("216");
    await page.getByLabel("Expected maximum").fill("253");
    await page.getByRole("button", { name: "Save reading" }).click();

    // The reading is evaluated server-side and the verdict is shown.
    await expect(page.getByText("228")).toBeVisible();
    await expect(page.getByText("In range")).toBeVisible();
    await expect(
      page.getByText(/range supplied by technician, not a verified standard/),
    ).toBeVisible();

    // Close the entry form so the circuit picker's <option> elements stop
    // shadowing the recorded reading's own circuit label. `exact` keeps
    // this off the "Circuit "Kitchen ring" added" toast.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Kitchen ring", { exact: true })).toBeVisible();

    // --- Start an investigation and read the safety verdict.
    await page.getByRole("button", { name: "Start investigation" }).click();
    await page
      .getByLabel("What is the symptom?")
      .fill("Breaker trips within 5 seconds of reset");
    await page.getByRole("button", { name: "Start", exact: true }).click();

    await expect(
      page.getByText("Breaker trips within 5 seconds of reset"),
    ).toBeVisible();

    // The safety block renders, and the precautions are always present.
    await expect(page.getByText("Always")).toBeVisible();
    await expect(
      page.getByText(/never certifies the condition/),
    ).toBeVisible();
    await expect(
      page.getByText(/Independently verify absence of voltage/),
    ).toBeVisible();

    // One reading, attributed to one circuit, so the circuit is
    // identified and no rule escalates -> the floor state. Which is
    // explicitly NOT an all-clear, and the UI must not present it as one.
    await expect(
      page.getByText("No blocking condition found"),
    ).toBeVisible();
    await expect(page.getByText(/\ball clear\b/i)).toHaveCount(0);
    await expect(page.getByText(/\bis safe\b/i)).toHaveCount(0);

    // --- Add a cause and confirm it; the session state follows.
    await page
      .getByLabel("Add a possible cause")
      .fill("Shorted conductor in the branch circuit");
    await page
      .getByLabel("What would settle it?")
      .fill("Insulation resistance test on that run");
    await page.getByRole("button", { name: "Add cause" }).click();

    await expect(
      page.getByText("Shorted conductor in the branch circuit"),
    ).toBeVisible();
    await expect(page.getByText("Candidate")).toBeVisible();
    await expect(
      page.getByText("Next test: Insulation resistance test on that run"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Cause confirmed")).toBeVisible();
    await expect(page.getByText("Confirmed")).toBeVisible();
    await expect(page.getByText("Diagnosed")).toBeVisible();
  });

  test("an unevaluated reading escalates the safety verdict, and the reason is shown", async ({
    page,
  }) => {
    // Scenario C from the Phase 5 brief: insufficient information must
    // surface as such, with the missing item named -- never as a clean
    // result.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login$/);

    await page.goto(`/orgs/${orgId}/jobs`);
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Unclear fault");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "Unclear fault" }),
    ).toBeVisible();

    // A reading with no expected range: recorded, but with nothing to
    // judge it against.
    await page.getByRole("button", { name: "Record reading" }).click();
    await page.getByLabel("Test type").selectOption("resistance");
    await page.getByLabel("Reading").fill("0.4");
    await page.getByRole("button", { name: "Save reading" }).click();
    await expect(page.getByText("No range given")).toBeVisible();

    await page.getByRole("button", { name: "Start investigation" }).click();
    await page.getByLabel("What is the symptom?").fill("Intermittent fault");
    await page.getByRole("button", { name: "Start", exact: true }).click();

    // The verdict escalates and names what to do about it.
    await expect(page.getByText("Not enough information")).toBeVisible();
    await expect(page.getByText("Verify before going further")).toBeVisible();
    await expect(
      page.getByText(/State the expected range for each unevaluated reading/),
    ).toBeVisible();
  });

  test("the AI panel is present and degrades cleanly when the provider is unavailable", async ({
    page,
  }) => {
    // ANTHROPIC_API_KEY is not configured in this environment, so this
    // exercises the real fail-safe path rather than a simulated one: the
    // advisor is unreachable and the deterministic workflow must be
    // completely unaffected.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login$/);

    await page.goto(`/orgs/${orgId}/jobs`);
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("AI panel check");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "AI panel check" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Record reading" }).click();
    await page.getByLabel("Reading").fill("230");
    await page.getByLabel("Expected minimum").fill("216");
    await page.getByLabel("Expected maximum").fill("253");
    await page.getByRole("button", { name: "Save reading" }).click();
    await expect(page.getByText("In range")).toBeVisible();

    await page.getByRole("button", { name: "Start investigation" }).click();
    await page.getByLabel("What is the symptom?").fill("Lights flicker");
    await page.getByRole("button", { name: "Start", exact: true }).click();

    // The AI panel is part of the session, not a separate screen, and it
    // states its own limits up front.
    await expect(page.getByRole("heading", { name: "AI reasoning" })).toBeVisible();
    await expect(
      page.getByText(/cannot change a measurement, a cause, or the safety verdict/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Ask AI" }).click();

    // A missing provider is reported plainly, and explicitly reassures
    // the technician that the rest of the page still works.
    await expect(
      page.getByText(/AI assistance is unavailable right now/),
    ).toBeVisible();

    // The deterministic workflow is untouched by the AI failure: the
    // safety verdict and the reading are still there, and a cause can
    // still be added and confirmed.
    await expect(page.getByText("Always")).toBeVisible();
    await expect(page.getByText("230")).toBeVisible();

    await page.getByLabel("Add a possible cause").fill("Loose connection");
    await page.getByRole("button", { name: "Add cause" }).click();
    await expect(page.getByText("Loose connection")).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Cause confirmed")).toBeVisible();
  });

  test("an invalid reading is rejected with a message an electrician can act on", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login$/);

    await page.goto(`/orgs/${orgId}/jobs`);
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Validation check");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "Validation check" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Record reading" }).click();

    // Non-numeric reading.
    await page.getByLabel("Reading").fill("not a number");
    await page.getByRole("button", { name: "Save reading" }).click();
    await expect(page.getByText("Enter the reading as a number.")).toBeVisible();

    // Inverted expected range.
    await page.getByLabel("Reading").fill("230");
    await page.getByLabel("Expected minimum").fill("300");
    await page.getByLabel("Expected maximum").fill("100");
    await page.getByRole("button", { name: "Save reading" }).click();
    await expect(
      page.getByText("Expected minimum cannot be greater than the maximum."),
    ).toBeVisible();

    // Nothing was persisted by either rejected attempt.
    await expect(page.getByText("No readings yet")).toBeVisible();
  });
});
