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
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { buildSafetyFacts } from "@/lib/safety/factBuilder";
import { isKnown, isUnknown, unwrapKnown } from "@/lib/safety/facts";
import { evaluateSafety } from "@/lib/safety/evaluate";

// Phase 4E extension of the tenant-isolation suite: the Safety Engine's
// only database-touching module. The threat model is the same as
// everywhere else (cross-org read, forged context, missing context), but
// the failure mode is worse than a leak -- an unreadable session that
// evaluated like a clean one would present as "nothing wrong here". Every
// assertion below therefore checks both that no data crossed, and that
// the verdict escalated rather than looking clean.
describe.skipIf(!dbTestsEnabled)("safety fact tenant isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let customerA: { id: string };
  let jobA: { id: string };
  let circuitA: { id: string };
  let sessionA: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-safety-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-safety-b-${randomUUID()}@example.invalid`;

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

    orgA = await organizationRepository.create(userA.id, "Safety Test Org A");
    orgB = await organizationRepository.create(userB.id, "Safety Test Org B");

    customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        customerRepository.create(tx, orgA.id, { name: "Safety Customer" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Breaker trips",
      }),
    );
    circuitA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        circuitRepository.create(tx, orgA.id, customerA.id, {
          label: "Kitchen ring",
        }),
    );
    sessionA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
          symptom: "Breaker trips within 5 seconds of reset",
        }),
    );
    await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      measurementRepository.create(tx, orgA.id, jobA.id, userA.id, {
        circuitId: circuitA.id,
        testType: "voltage_ac",
        value: 120,
        unit: "V",
        expectedMin: 114,
        expectedMax: 126,
        result: "pass",
      }),
    );
  });

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (privileged && orgIds.length > 0) {
      for (const table of [
        "ai_assessment_finding",
        "ai_assessment",
        "diagnostic_candidate_causes",
        "diagnostic_sessions",
        "measurements",
        "circuits",
        "jobs",
        "customers",
        "organization_memberships",
      ]) {
        await privileged.query(
          `delete from public.${table} where organization_id = any($1::uuid[])`,
          [orgIds],
        );
      }
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

  it("Safety 1: the owning org builds complete facts for its own session", async () => {
    const facts = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
    );
    expect(isKnown(facts.circuit_under_investigation)).toBe(true);
    expect(unwrapKnown(facts.circuit_under_investigation).circuitId).toBe(
      circuitA.id,
    );
    expect(unwrapKnown(facts.measurements_on_job)).toHaveLength(1);
    expect(unwrapKnown(facts.measurements_on_circuit)).toHaveLength(1);
  });

  it("Safety 2: org B cannot pull org A's facts through its own legitimate context", async () => {
    const facts = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => buildSafetyFacts(tx, orgB.id, jobA.id, sessionA.id),
    );
    expect(isUnknown(facts.circuit_under_investigation)).toBe(true);
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
    expect(isUnknown(facts.measurements_on_circuit)).toBe(true);
  });

  it("Safety 3: a forged org context yields no facts (is_member_of re-derivation)", async () => {
    // User B claims org A's id without holding a membership row.
    const facts = await withTenantContext(
      { userId: userB.id, orgId: orgA.id },
      (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
    );
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
  });

  it("Safety 4: a missing org context yields no facts", async () => {
    const facts = await withTenantContext(
      { userId: userA.id, orgId: null },
      (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
    );
    expect(isUnknown(facts.measurements_on_job)).toBe(true);
  });

  it("Safety 5: an inaccessible session escalates rather than looking clean", async () => {
    // The whole point. Denial must not read as an all-clear.
    const denied = evaluateSafety(
      await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        buildSafetyFacts(tx, orgB.id, jobA.id, sessionA.id),
      ),
    );
    expect(denied.state).toBe("INSUFFICIENT_INFORMATION");
    expect(denied.firedRuleIds.length).toBeGreaterThan(0);
  });

  it("Safety 6: no cross-org measurement ever enters the fact set", async () => {
    // Give org B its own job and measurement, then confirm neither org
    // sees the other's readings.
    const customerB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => customerRepository.create(tx, orgB.id, { name: "B Customer" }),
    );
    const jobB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) =>
        jobRepository.create(tx, orgB.id, userB.id, {
          customerId: customerB.id,
          title: "B job",
        }),
    );
    const sessionB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) =>
        diagnosticSessionRepository.create(tx, orgB.id, jobB.id, userB.id, {
          symptom: "B symptom",
        }),
    );
    await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      measurementRepository.create(tx, orgB.id, jobB.id, userB.id, {
        testType: "resistance",
        value: 0.3,
        unit: "Ω",
      }),
    );

    const factsB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => buildSafetyFacts(tx, orgB.id, jobB.id, sessionB.id),
    );
    const idsB = unwrapKnown(factsB.measurements_on_job).map(
      (m) => m.measurementId,
    );
    expect(idsB).toHaveLength(1);

    const factsA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
    );
    const idsA = unwrapKnown(factsA.measurements_on_job).map(
      (m) => m.measurementId,
    );
    for (const id of idsB) expect(idsA).not.toContain(id);
    for (const id of idsA) expect(idsB).not.toContain(id);
  });

  it("Safety 8: a persisted arc-fault finding produces STOP through the real stack", async () => {
    // The end-to-end proof that STOP is reachable: a completed assessment
    // carrying an acute hazard category, read back through the real
    // factBuilder under RLS, evaluated by the real lattice.
    //
    // Seeded with the privileged pool because the executor cannot run
    // here (no ANTHROPIC_API_KEY) -- the same approach
    // assessment-flow.spec.ts already uses to seed a completed run.
    const assessmentId = randomUUID();
    const findingId = randomUUID();
    await privileged.query(
      `insert into public.ai_assessment
         (id, organization_id, job_id, requested_by_user_id, version, status,
          model_id, prompt_version, schema_version, updated_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'complete',
               'fixture-model', 'test', 'test', now())`,
      [assessmentId, orgA.id, jobA.id, userA.id],
    );
    await privileged.query(
      `insert into public.ai_assessment_finding
         (id, assessment_id, organization_id, kind, ref, statement,
          confidence, rationale, safety_categories)
       values ($1::uuid, $2::uuid, $3::uuid, 'hypothesis', 'H1',
               'Scorching around the breaker terminals.', 'medium',
               'Consistent with the reported symptom.', $4::text[])`,
      [findingId, assessmentId, orgA.id, ["arc_fault_suspected"]],
    );

    try {
      const facts = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
      );
      expect(unwrapKnown(facts.ai_hazard_categories)).toEqual([
        "arc_fault_suspected",
      ]);

      const verdict = evaluateSafety(facts);
      expect(verdict.state).toBe("STOP");
      expect(verdict.firedRuleIds).toContain("ai_hazard_arc_fault_suspected");
      // The precautions still attach at STOP, as at every other state.
      expect(verdict.precautions.length).toBeGreaterThan(0);

      // And a technician rejecting the finding clears it -- a change in
      // the facts, not a downgrade of the verdict.
      await privileged.query(
        `insert into public.technician_verdict
           (id, organization_id, assessment_id, finding_id, verdict,
            created_by_user_id, updated_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'rejected',
                 $5::uuid, now())`,
        [randomUUID(), orgA.id, assessmentId, findingId, userA.id],
      );
      const afterRejection = await withTenantContext(
        { userId: userA.id, orgId: orgA.id },
        (tx) => buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
      );
      expect(unwrapKnown(afterRejection.ai_hazard_categories)).toEqual([]);
      expect(evaluateSafety(afterRejection).state).not.toBe("STOP");
    } finally {
      await privileged.query(
        `delete from public.technician_verdict where assessment_id = $1::uuid`,
        [assessmentId],
      );
      await privileged.query(
        `delete from public.ai_assessment_finding where assessment_id = $1::uuid`,
        [assessmentId],
      );
      await privileged.query(
        `delete from public.ai_assessment where id = $1::uuid`,
        [assessmentId],
      );
    }
  });

  it("Safety 7: building facts mutates no diagnostic state", async () => {
    const before = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.getFullById(
          tx,
          orgA.id,
          jobA.id,
          sessionA.id,
        ),
    );
    await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      buildSafetyFacts(tx, orgA.id, jobA.id, sessionA.id),
    );
    const after = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.getFullById(
          tx,
          orgA.id,
          jobA.id,
          sessionA.id,
        ),
    );
    expect(after?.status).toBe(before?.status);
    expect(after?.symptom).toBe(before?.symptom);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(after?.causes.length).toBe(before?.causes.length);
  });
});
