import { test, expect } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

loadEnv({ path: ".env.local", quiet: true });

// Same opt-in gate as tests/security/* and the other live-DB e2e specs.
const runDbTests = process.env.RUN_DB_SECURITY_TESTS === "true";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Phase 3B has no UI: this drives the browser only far enough to obtain an
// authenticated session (login, org, customer, one job), then exercises
// the new diagnostics/measurements API routes directly via `page.request`,
// which shares the browser context's session cookie. That's what actually
// integration-tests the route layer -- auth, the job/session/cause
// ownership checks, and error-code mapping -- none of which the Phase 3A
// repository-level security tests could exercise, since those call
// repositories directly and never go through a route handler.
test.describe("diagnostic session API flow", () => {
  test.skip(
    !runDbTests,
    "requires RUN_DB_SECURITY_TESTS=true and a live Supabase project",
  );

  test.describe.configure({ timeout: 120_000 });

  let email: string;
  let password: string;
  let userId: string;
  let orgId: string | undefined;

  test.beforeAll(async () => {
    email = `tradeai-e2e-diag-${randomUUID()}@example.invalid`;
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
    if (orgId) {
      const pool = new Pool({ connectionString: process.env.DIRECT_URL });
      await pool.query(
        `delete from public.diagnostic_candidate_causes where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(
        `delete from public.diagnostic_sessions where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(
        `delete from public.measurements where organization_id = $1::uuid`,
        [orgId],
      );
      await pool.query(`delete from public.jobs where organization_id = $1::uuid`, [
        orgId,
      ]);
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
    if (userId) await adminClient().auth.admin.deleteUser(userId);
  });

  test("session/cause CRUD, ownership checks, the confirm invariant, and measurement-result wiring", async ({
    page,
  }) => {
    // --- Establish an authenticated session, org, customer, and two jobs.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(/\/orgs$/);

    await page.getByLabel("Business name").fill(`E2E Diag ${randomUUID()}`);
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]+\/jobs$/);
    orgId = page.url().split("/orgs/")[1].split("/")[0];

    await page.getByRole("link", { name: "Customers", exact: true }).click();
    await page.getByRole("button", { name: "+ New Customer" }).click();
    await page.getByLabel("Name").fill("Diagnostics Customer");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(
      page.getByRole("link", { name: "Diagnostics Customer" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Panel troubleshooting");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "Panel troubleshooting" }),
    ).toBeVisible();
    const jobId = page.url().split("/jobs/")[1].split(/[/?#]/)[0];

    // A second job in the same org, used only for the cross-job ownership
    // checks below.
    await page.goto(`/orgs/${orgId}/jobs`);
    await page.getByRole("button", { name: "+ New Job" }).click();
    await page.getByLabel("Job title").fill("Unrelated second job");
    await page.getByRole("button", { name: "Create job" }).click();
    await expect(
      page.getByRole("heading", { name: "Unrelated second job" }),
    ).toBeVisible();
    const otherJobId = page.url().split("/jobs/")[1].split(/[/?#]/)[0];

    // --- Create a diagnostic session and two candidate causes.
    const createSessionResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics`,
      { data: { symptom: "Breaker trips within 5 seconds of reset" } },
    );
    expect(createSessionResponse.status()).toBe(201);
    const { session } = await createSessionResponse.json();
    expect(session.status).toBe("open");

    const listResponse = await page.request.get(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics`,
    );
    expect(listResponse.ok()).toBe(true);
    const { sessions } = await listResponse.json();
    expect(sessions.map((s: { id: string }) => s.id)).toContain(session.id);

    const causeOneResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes`,
      { data: { statement: "Shorted branch circuit conductor" } },
    );
    expect(causeOneResponse.status()).toBe(201);
    const { cause: causeOne } = await causeOneResponse.json();
    expect(causeOne.status).toBe("candidate");

    const causeTwoResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes`,
      { data: { statement: "Failing breaker itself" } },
    );
    const { cause: causeTwo } = await causeTwoResponse.json();

    // --- Confirming one cause moves the session to diagnosed.
    const confirmOneResponse = await page.request.patch(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes/${causeOne.id}`,
      { data: { status: "confirmed" } },
    );
    expect(confirmOneResponse.ok()).toBe(true);
    expect((await confirmOneResponse.json()).cause.status).toBe("confirmed");

    const sessionDetailResponse = await page.request.get(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}`,
    );
    const { session: sessionDetail, safety } =
      await sessionDetailResponse.json();
    expect(sessionDetail.status).toBe("diagnosed");
    expect(sessionDetail.causes).toHaveLength(2);

    // --- The safety block accompanies the session, computed on read.
    expect(safety).toBeDefined();
    expect(safety.rulesetVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(Array.isArray(safety.firedRuleIds)).toBe(true);
    expect(Array.isArray(safety.verifications)).toBe(true);
    expect(safety.precautions.length).toBeGreaterThan(0);
    // No permissive verdict exists for it to report.
    expect([
      "STOP",
      "INSUFFICIENT_INFORMATION",
      "PROCEED_WITH_PRECAUTIONS",
    ]).toContain(safety.state);

    // No measurement on this job references a circuit yet, so the circuit
    // under investigation is unidentified and the verdict must escalate
    // rather than read as clean.
    expect(safety.state).toBe("INSUFFICIENT_INFORMATION");
    expect(safety.firedRuleIds).toContain("circuit_not_uniquely_identified");
    expect(safety.unknownFacts).toContain("circuit_under_investigation");
    expect(safety.verifications.length).toBeGreaterThan(0);

    // --- The at-most-one-confirmed invariant surfaces as 409.
    const confirmTwoResponse = await page.request.patch(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes/${causeTwo.id}`,
      { data: { status: "confirmed" } },
    );
    expect(confirmTwoResponse.status()).toBe(409);
    expect((await confirmTwoResponse.json()).error).toBe(
      "cause_already_confirmed",
    );

    // --- Ownership: a session doesn't resolve under the wrong job.
    const wrongJobSessionResponse = await page.request.get(
      `/api/orgs/${orgId}/jobs/${otherJobId}/diagnostics/${session.id}`,
    );
    expect(wrongJobSessionResponse.status()).toBe(404);

    // --- Ownership: creating a cause under a session/job mismatch 404s.
    // Unlike the cause-update route, this one does not name a `field` --
    // it has only one referenced entity to reject, so there is nothing to
    // disambiguate.
    const wrongJobCauseResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${otherJobId}/diagnostics/${session.id}/causes`,
      { data: { statement: "Should never be created" } },
    );
    expect(wrongJobCauseResponse.status()).toBe(404);
    expect((await wrongJobCauseResponse.json()).error).toBe("not_found");

    // --- Measurement.result is now computed synchronously at creation.
    const passingMeasurementResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/measurements`,
      {
        data: {
          testType: "voltage_ac",
          value: 120,
          unit: "V",
          expectedMin: 114,
          expectedMax: 126,
        },
      },
    );
    expect(passingMeasurementResponse.status()).toBe(201);
    const { measurement: passingMeasurement } =
      await passingMeasurementResponse.json();
    expect(passingMeasurement.result).toBe("pass");

    const failingMeasurementResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/measurements`,
      {
        data: {
          testType: "voltage_ac",
          value: 95,
          unit: "V",
          expectedMin: 114,
          expectedMax: 126,
        },
      },
    );
    const { measurement: failingMeasurement } =
      await failingMeasurementResponse.json();
    expect(failingMeasurement.result).toBe("fail");

    const noRangeMeasurementResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${jobId}/measurements`,
      { data: { testType: "voltage_ac", value: 120, unit: "V" } },
    );
    const { measurement: noRangeMeasurement } =
      await noRangeMeasurementResponse.json();
    expect(noRangeMeasurement.result).toBe("not_applicable");

    // --- Linking a resolving measurement is informational only: it
    // never changes the cause's status by itself.
    const linkResponse = await page.request.patch(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes/${causeTwo.id}`,
      { data: { resolvingMeasurementId: failingMeasurement.id } },
    );
    expect(linkResponse.ok()).toBe(true);
    const { cause: linkedCause } = await linkResponse.json();
    expect(linkedCause.resolvingMeasurementId).toBe(failingMeasurement.id);
    expect(linkedCause.status).toBe("candidate");

    // --- A resolving measurement from a different job is rejected, not
    // silently linked.
    const otherJobMeasurementResponse = await page.request.post(
      `/api/orgs/${orgId}/jobs/${otherJobId}/measurements`,
      { data: { testType: "resistance", value: 0.1, unit: "Ω" } },
    );
    const { measurement: otherJobMeasurement } =
      await otherJobMeasurementResponse.json();

    const crossJobLinkResponse = await page.request.patch(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}/causes/${causeTwo.id}`,
      { data: { resolvingMeasurementId: otherJobMeasurement.id } },
    );
    expect(crossJobLinkResponse.status()).toBe(404);
    expect((await crossJobLinkResponse.json()).field).toBe("measurement");

    // --- Safety is recomputed on read and never mutates the session.
    // By now the job carries an unevaluated reading (no expected range),
    // which must surface as its own finding rather than pass unnoticed.
    const finalResponse = await page.request.get(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}`,
    );
    const { session: finalSession, safety: finalSafety } =
      await finalResponse.json();

    expect(finalSafety.firedRuleIds).toContain("unevaluated_measurement");
    expect(finalSafety.state).toBe("INSUFFICIENT_INFORMATION");

    // Existing diagnostic fields are untouched by the evaluation: same
    // status, same symptom, same causes, same updatedAt.
    expect(finalSession.status).toBe(sessionDetail.status);
    expect(finalSession.symptom).toBe(sessionDetail.symptom);
    expect(finalSession.updatedAt).toBe(sessionDetail.updatedAt);
    expect(finalSession.causes).toHaveLength(sessionDetail.causes.length);
    expect(
      finalSession.causes.map((c: { id: string; status: string }) => c.status),
    ).toEqual(
      sessionDetail.causes.map((c: { id: string; status: string }) => c.status),
    );

    // Two consecutive reads with no intervening write are identical.
    const repeatResponse = await page.request.get(
      `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${session.id}`,
    );
    const { safety: repeatSafety } = await repeatResponse.json();
    expect(repeatSafety).toEqual(finalSafety);
  });
});
