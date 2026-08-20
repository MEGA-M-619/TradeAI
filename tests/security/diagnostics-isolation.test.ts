import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";
import { prisma } from "@/lib/db/prisma";
import { withTenantContext } from "@/lib/db/tenantContext";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import {
  diagnosticCauseRepository,
  DiagnosticCauseConflictError,
} from "@/lib/db/repositories/diagnosticCauseRepository";

// Phase 3A extension of the tenant-isolation suite: same threat model
// (cross-org access, forged context) applied to diagnostic_sessions and
// diagnostic_candidate_causes, plus coverage of the two deterministic
// state-machine invariants those tables' repositories enforce in
// application code (see diagnosticCauseRepository.update). Requires a
// live Supabase project. Skipped by default.
describe.skipIf(!dbTestsEnabled)("diagnostics tenant isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let customerA: { id: string };
  let jobA: { id: string };
  let sessionA: { id: string };
  let causeA: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-diag-test-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-diag-test-b-${randomUUID()}@example.invalid`;

    const { data: createdA, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    if (errA || !createdA.user) throw errA ?? new Error("user A create failed");
    const { data: createdB, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (errB || !createdB.user) throw errB ?? new Error("user B create failed");

    userA = { id: createdA.user.id, email: emailA };
    userB = { id: createdB.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);

    orgA = await organizationRepository.create(userA.id, "Diag Test Org A");
    orgB = await organizationRepository.create(userB.id, "Diag Test Org B");

    customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        customerRepository.create(tx, orgA.id, { name: "Diag Test Customer" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Intermittent breaker trip",
      }),
    );
    sessionA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
          symptom: "Breaker trips within 5 seconds of reset",
        }),
    );
    causeA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticCauseRepository.create(
          tx,
          orgA.id,
          sessionA.id,
          userA.id,
          { statement: "Shorted branch circuit conductor" },
        ),
    );
  });

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (privileged && orgIds.length > 0) {
      await privileged.query(
        `delete from public.diagnostic_candidate_causes where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.diagnostic_sessions where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.measurements where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.jobs where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.customers where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organization_memberships where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organizations where id = any($1::uuid[])`,
        [orgIds],
      );
    }
    if (admin && userA) await admin.auth.admin.deleteUser(userA.id);
    if (admin && userB) await admin.auth.admin.deleteUser(userB.id);
    await privileged?.end();
    await prisma.$disconnect();
  });

  describe("isolation", () => {
    it("same-org access: the owning org can read its own session and cause", async () => {
      const session = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) => diagnosticSessionRepository.getById(tx, orgA.id, jobA.id, sessionA.id),
      );
      expect(session?.id).toBe(sessionA.id);

      const cause = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.getById(tx, orgA.id, sessionA.id, causeA.id),
      );
      expect(cause?.id).toBe(causeA.id);
    });

    it("cross-org access: org B cannot read org A's session or cause via its own (legitimate) context", async () => {
      const session = await withTenantContext(
        { userId: userB.id, orgId: orgB.id },
        (tx) => diagnosticSessionRepository.getById(tx, orgB.id, jobA.id, sessionA.id),
      );
      expect(session).toBeNull();

      const cause = await withTenantContext(
        { userId: userB.id, orgId: orgB.id },
        (tx) =>
          diagnosticCauseRepository.getById(tx, orgB.id, sessionA.id, causeA.id),
      );
      expect(cause).toBeNull();
    });

    it("forged context: userB with app.current_org_id forced to orgA still sees nothing (is_member_of re-derivation)", async () => {
      const session = await withTenantContext(
        { userId: userB.id, orgId: orgA.id },
        (tx) => diagnosticSessionRepository.getById(tx, orgA.id, jobA.id, sessionA.id),
      );
      expect(session).toBeNull();
    });

    it("listing is scoped per org: org B's session list never includes org A's sessions", async () => {
      const listForB = await withTenantContext(
        { userId: userB.id, orgId: orgB.id },
        (tx) => diagnosticSessionRepository.listForJob(tx, orgB.id, jobA.id),
      );
      expect(listForB.map((s) => s.id)).not.toContain(sessionA.id);
    });

    it("a cross-org write is rejected (record not found), not silently applied", async () => {
      await expect(
        withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
          diagnosticCauseRepository.update(tx, orgB.id, sessionA.id, causeA.id, {
            status: "ruled_out",
          }),
        ),
      ).rejects.toThrow();

      const stillCandidate = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.getById(tx, orgA.id, sessionA.id, causeA.id),
      );
      expect(stillCandidate?.status).toBe("candidate");
    });
  });

  describe("state-machine invariants", () => {
    it("confirming a cause transitions its session to diagnosed", async () => {
      const session = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
            symptom: "GFCI won't reset",
          }),
      );
      const cause = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.create(tx, orgA.id, session.id, userA.id, {
            statement: "Moisture in the outlet box",
          }),
      );

      await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
        diagnosticCauseRepository.update(tx, orgA.id, session.id, cause.id, {
          status: "confirmed",
        }),
      );

      const updatedSession = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) => diagnosticSessionRepository.getById(tx, orgA.id, jobA.id, session.id),
      );
      expect(updatedSession?.status).toBe("diagnosed");
    });

    it("confirming a second cause while one is already confirmed throws DiagnosticCauseConflictError, and nothing changes", async () => {
      const session = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
            symptom: "Flickering lights on one circuit",
          }),
      );
      const causeOne = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.create(tx, orgA.id, session.id, userA.id, {
            statement: "Loose wire nut on the neutral",
          }),
      );
      const causeTwo = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.create(tx, orgA.id, session.id, userA.id, {
            statement: "Failing dimmer switch",
          }),
      );

      await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
        diagnosticCauseRepository.update(tx, orgA.id, session.id, causeOne.id, {
          status: "confirmed",
        }),
      );

      await expect(
        withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
          diagnosticCauseRepository.update(tx, orgA.id, session.id, causeTwo.id, {
            status: "confirmed",
          }),
        ),
      ).rejects.toThrow(DiagnosticCauseConflictError);

      const [refetchedOne, refetchedTwo] = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        async (tx) => [
          await diagnosticCauseRepository.getById(tx, orgA.id, session.id, causeOne.id),
          await diagnosticCauseRepository.getById(tx, orgA.id, session.id, causeTwo.id),
        ],
      );
      expect(refetchedOne?.status).toBe("confirmed");
      expect(refetchedTwo?.status).toBe("candidate");
    });

    it("un-confirming a cause does not revert the session's diagnosed status (documented scope decision)", async () => {
      const session = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
            symptom: "Outlet is warm to the touch",
          }),
      );
      const cause = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.create(tx, orgA.id, session.id, userA.id, {
            statement: "Overloaded circuit",
          }),
      );

      await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
        diagnosticCauseRepository.update(tx, orgA.id, session.id, cause.id, {
          status: "confirmed",
        }),
      );
      await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
        diagnosticCauseRepository.update(tx, orgA.id, session.id, cause.id, {
          status: "ruled_out",
        }),
      );

      const updatedSession = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) => diagnosticSessionRepository.getById(tx, orgA.id, jobA.id, session.id),
      );
      // Still "diagnosed" -- confirming is the only transition this phase
      // implements; reverting was left explicitly unimplemented.
      expect(updatedSession?.status).toBe("diagnosed");
    });

    it("linking a resolving measurement is informational: it never changes status by itself", async () => {
      const measurement = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          measurementRepository.create(tx, orgA.id, jobA.id, userA.id, {
            testType: "continuity",
            value: 0.2,
            unit: "Ω",
          }),
      );

      const updated = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) =>
          diagnosticCauseRepository.update(tx, orgA.id, sessionA.id, causeA.id, {
            resolvingMeasurementId: measurement.id,
          }),
      );

      expect(updated.resolvingMeasurementId).toBe(measurement.id);
      expect(updated.status).toBe("candidate");
    });
  });
});
