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
import { diagnosticCauseRepository } from "@/lib/db/repositories/diagnosticCauseRepository";
import { buildAdvisorContext } from "@/lib/ai/advisor/context";
import { requestDiagnosticAdvice } from "@/lib/ai/advisor/service";
import {
  FixtureDiagnosticAdvisor,
  validAdvisorPayload,
} from "@/lib/ai/advisor/fixtureAdvisor";

/**
 * Phase 6 extension of the isolation suite. The AI endpoint is a new way
 * to read tenant data, so it gets the same threat model as every other
 * read -- plus the failure that is unique to it: a model must never be
 * told about a job the caller cannot see.
 *
 * The advisor is a fixture throughout. These tests are about the context
 * boundary and the failure paths, not about model quality.
 */
describe.skipIf(!dbTestsEnabled)("advisor context isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let jobA: { id: string };
  let sessionA: { id: string };
  let measurementA: { id: string };
  let causeA: { id: string };

  // Org B's own world, used to prove nothing crosses between them.
  let jobB: { id: string };
  let sessionB: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-advisor-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-advisor-b-${randomUUID()}@example.invalid`;
    const { data: a } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    const { data: b } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (!a.user || !b.user) throw new Error("could not create test users");
    userA = { id: a.user.id, email: emailA };
    userB = { id: b.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);
    orgA = await organizationRepository.create(userA.id, "Advisor Org A");
    orgB = await organizationRepository.create(userB.id, "Advisor Org B");

    const customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.create(tx, orgA.id, { name: "Secret Customer A" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Org A confidential job",
      }),
    );
    const circuitA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        circuitRepository.create(tx, orgA.id, customerA.id, {
          label: "A-only circuit",
        }),
    );
    measurementA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        measurementRepository.create(tx, orgA.id, jobA.id, userA.id, {
          circuitId: circuitA.id,
          testType: "voltage_ac",
          value: 230,
          unit: "V",
          expectedMin: 216,
          expectedMax: 253,
          result: "pass",
        }),
    );
    sessionA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.create(tx, orgA.id, jobA.id, userA.id, {
          symptom: "Org A symptom",
        }),
    );
    causeA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticCauseRepository.create(tx, orgA.id, sessionA.id, userA.id, {
          statement: "Org A cause",
        }),
    );

    const customerB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => customerRepository.create(tx, orgB.id, { name: "Customer B" }),
    );
    jobB = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      jobRepository.create(tx, orgB.id, userB.id, {
        customerId: customerB.id,
        title: "Org B job",
      }),
    );
    sessionB = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) =>
        diagnosticSessionRepository.create(tx, orgB.id, jobB.id, userB.id, {
          symptom: "Org B symptom",
        }),
    );
  });

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (privileged && orgIds.length > 0) {
      for (const table of [
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

  it("Advisor 1: the owning org gets a complete, grounded context", async () => {
    const built = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => buildAdvisorContext(tx, orgA.id, jobA.id, sessionA.id),
    );
    expect(built).not.toBeNull();
    expect(built!.context.measurements.map((m) => m.id)).toEqual([
      measurementA.id,
    ]);
    expect(built!.context.causes.map((c) => c.id)).toEqual([causeA.id]);
    expect(built!.context.circuit?.label).toBe("A-only circuit");
    expect(built!.context.safety.state).toBeDefined();
    expect(built!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("Advisor 2: org B cannot build a context for org A's session", async () => {
    const built = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) => buildAdvisorContext(tx, orgB.id, jobA.id, sessionA.id),
    );
    expect(built).toBeNull();
  });

  it("Advisor 3: a forged org context yields nothing", async () => {
    const built = await withTenantContext(
      { userId: userB.id, orgId: orgA.id },
      (tx) => buildAdvisorContext(tx, orgA.id, jobA.id, sessionA.id),
    );
    expect(built).toBeNull();
  });

  it("Advisor 4: the service returns not_found rather than leaking across tenants", async () => {
    const advisor = FixtureDiagnosticAdvisor.withPayload(validAdvisorPayload());
    const outcome = await withTenantContext(
      { userId: userB.id, orgId: orgB.id },
      (tx) =>
        requestDiagnosticAdvice(
          tx,
          orgB.id,
          jobA.id,
          sessionA.id,
          null,
          () => advisor,
        ),
    );
    expect(outcome.status).toBe("not_found");
    // The decisive assertion: the model was never called at all, so org
    // A's data could not have reached a provider.
    expect(advisor.callCount).toBe(0);
  });

  it("Advisor 5: no cross-tenant data appears in what the model is sent", async () => {
    const advisor = FixtureDiagnosticAdvisor.withPayload(validAdvisorPayload());
    await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      requestDiagnosticAdvice(
        tx,
        orgB.id,
        jobB.id,
        sessionB.id,
        null,
        () => advisor,
      ),
    );
    const sent = JSON.stringify(advisor.lastInput);
    expect(sent).toContain("Org B symptom");
    for (const secret of [
      "Org A confidential job",
      "Secret Customer A",
      "A-only circuit",
      "Org A symptom",
      "Org A cause",
      measurementA.id,
      causeA.id,
    ]) {
      expect(sent, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it("Advisor 6: the context carries no customer PII", async () => {
    const advisor = FixtureDiagnosticAdvisor.withPayload(validAdvisorPayload());
    await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      requestDiagnosticAdvice(
        tx,
        orgA.id,
        jobA.id,
        sessionA.id,
        null,
        () => advisor,
      ),
    );
    const sent = JSON.stringify(advisor.lastInput);
    // The customer's name is deliberately not part of the context.
    expect(sent).not.toContain("Secret Customer A");
    expect(sent).not.toContain(userA.email);
    expect(sent).not.toContain(userA.id);
  });

  it("Advisor 7: the real safety verdict reaches the model", async () => {
    const advisor = FixtureDiagnosticAdvisor.withPayload(validAdvisorPayload());
    const outcome = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        requestDiagnosticAdvice(
          tx,
          orgA.id,
          jobA.id,
          sessionA.id,
          null,
          () => advisor,
        ),
    );
    expect(outcome.status).toBe("ok");
    const context = advisor.lastInput!.context;
    expect(["STOP", "INSUFFICIENT_INFORMATION", "PROCEED_WITH_PRECAUTIONS"]).toContain(
      context.safety.state,
    );
    expect(advisor.lastInput!.systemPrompt).toMatch(/not yours to make/i);
  });

  it("Advisor 8: a provider outage degrades cleanly and changes nothing", async () => {
    const outcome = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        requestDiagnosticAdvice(tx, orgA.id, jobA.id, sessionA.id, null, () =>
          FixtureDiagnosticAdvisor.failing("rate limited"),
        ),
    );
    expect(outcome.status).toBe("unavailable");

    // The deterministic state is untouched by the failure.
    const session = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        diagnosticSessionRepository.getFullById(
          tx,
          orgA.id,
          jobA.id,
          sessionA.id,
        ),
    );
    expect(session?.causes).toHaveLength(1);
    expect(session?.causes[0].status).toBe("candidate");
  });

  it("Advisor 9: an ungrounded answer is rejected, not shown", async () => {
    const outcome = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) =>
        requestDiagnosticAdvice(tx, orgA.id, jobA.id, sessionA.id, null, () =>
          FixtureDiagnosticAdvisor.withPayload(
            validAdvisorPayload({
              evidence: [
                {
                  statement: "Cited a reading from another job.",
                  citedMeasurementIds: [
                    "11111111-1111-4111-8111-111111111111",
                  ],
                },
              ],
            }),
          ),
        ),
    );
    expect(outcome.status).toBe("ungrounded");
  });

  it("Advisor 10: the model cannot write to deterministic state", async () => {
    // Even a well-formed answer persists nothing: the advisor path has no
    // write of any kind.
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
      requestDiagnosticAdvice(tx, orgA.id, jobA.id, sessionA.id, null, () =>
        FixtureDiagnosticAdvisor.withPayload(
          validAdvisorPayload({
            likelyExplanations: [
              {
                statement: "This is definitely the cause",
                causeId: causeA.id,
                support: "well_supported",
                reasoning: "Strong agreement with the readings.",
                citedMeasurementIds: [measurementA.id],
              },
            ],
          }),
        ),
      ),
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
    // The AI called a cause "definitely the cause"; it remains a candidate.
    expect(after?.causes[0].status).toBe("candidate");
    expect(after?.causes[0].status).toBe(before?.causes[0].status);
    expect(after?.status).toBe(before?.status);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });
});
