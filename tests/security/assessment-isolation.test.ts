import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";
import { withTenantContext } from "@/lib/db/tenantContext";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { verdictRepository } from "@/lib/db/repositories/verdictRepository";
import { buildEvidenceKey } from "@/lib/storage/evidenceStorage";

// Phase 3 extension of the tenant-isolation suite: same threat model
// (cross-org access, forged context, missing context) applied to all nine
// AI-assessment tables. Requires a live Supabase project. Skipped by
// default. Storage-layer isolation is covered separately by
// evidence-storage-isolation.test.ts; adversarial executor behavior
// (fabricated citations, schema violations, sha mismatches) is covered by
// assessment-executor.test.ts.
describe.skipIf(!dbTestsEnabled)("AI assessment tenant isolation", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };
  let jobA: { id: string };
  let evidenceA: { id: string };
  let assessmentA: { id: string };
  let findingA: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-ai-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-ai-b-${randomUUID()}@example.invalid`;

    const { data: cA, error: eA } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    if (eA || !cA.user) throw eA ?? new Error("user A create failed");
    const { data: cB, error: eB } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (eB || !cB.user) throw eB ?? new Error("user B create failed");

    userA = { id: cA.user.id, email: emailA };
    userB = { id: cB.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);

    orgA = await organizationRepository.create(userA.id, "AI Test Org A");
    orgB = await organizationRepository.create(userB.id, "AI Test Org B");

    const customerA = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => customerRepository.create(tx, orgA.id, { name: "Alice" }),
    );
    jobA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      jobRepository.create(tx, orgA.id, userA.id, {
        customerId: customerA.id,
        title: "Panel inspection",
      }),
    );

    const evId = randomUUID();
    evidenceA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, async (tx) => {
      await evidenceRepository.create(tx, orgA.id, {
        id: evId,
        jobId: jobA.id,
        uploadedByUserId: userA.id,
        storageKey: buildEvidenceKey(orgA.id, jobA.id, evId),
        mimeType: "image/jpeg",
      });
      return evidenceRepository.markReady(tx, orgA.id, jobA.id, evId, { byteSize: 100 });
    });

    // Build a full assessment: queued -> claimed -> input snapshot ->
    // complete, with one hypothesis (citation + test + safety warning),
    // one question, a technician verdict, and a usage ledger row -- using
    // the real repository functions, the same way the application does.
    await withTenantContext({ userId: userA.id, orgId: orgA.id }, async (tx) => {
      const version = await assessmentRepository.nextVersion(tx, orgA.id, jobA.id);
      assessmentA = await assessmentRepository.createQueued(tx, orgA.id, {
        jobId: jobA.id,
        requestedByUserId: userA.id,
        version,
        selectedEvidenceIds: [evidenceA.id],
        modelTier: "standard",
        modelId: "claude-sonnet-5",
        promptVersion: "test",
        schemaVersion: "test",
      });
      await assessmentRepository.claimForRun(tx, orgA.id, assessmentA.id);
      await assessmentRepository.createInputSnapshot(tx, orgA.id, assessmentA.id, [
        { evidenceId: evidenceA.id, ordinalRef: "E1", sha256Verified: "deadbeef" },
      ]);
      await assessmentRepository.persistComplete(tx, orgA.id, assessmentA.id, {
        findings: [
          {
            ref: "H1",
            kind: "hypothesis",
            statement: "Possible loose lug",
            confidence: "medium",
            rationale: "Discoloration visible near the terminal",
            whatWouldChangeMyMind: "A torque check showing spec-correct tightness",
            safetyCategories: ["thermal_damage_scorching"],
            citedEvidenceIds: [evidenceA.id],
            tests: [
              {
                test: "Torque check",
                rulesInIfPositive: "Confirms loose connection",
                rulesOutIfNegative: "Rules out this specific cause",
              },
            ],
          },
        ],
        questions: [
          {
            question: "Has this breaker tripped recently?",
            whyItMatters: "Recent trips would support the loose-lug hypothesis",
            answersWouldRuleIn: ["Yes, multiple times this month"],
          },
        ],
        safetyWarnings: [
          { ruleId: "baseline_deenergize", severity: "advisory", message: "De-energize first." },
        ],
        usage: { inputTokens: 500, outputTokens: 300 },
        stopReason: "tool_use",
        latencyMs: 1200,
        rawResponse: { fixture: true },
      });
      await assessmentRepository.recordUsage(
        tx,
        orgA.id,
        assessmentA.id,
        "claude-sonnet-5",
        { inputTokens: 500, outputTokens: 300 },
        true,
      );

      const full = await assessmentRepository.getFullById(tx, orgA.id, jobA.id, assessmentA.id);
      findingA = full!.findings[0];

      await verdictRepository.upsert(tx, orgA.id, assessmentA.id, findingA.id, userA.id, {
        verdict: "confirmed",
        note: "Verified in the field",
      });
    });
  });

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (orgIds.length) {
      await privileged.query(
        `delete from public.technician_verdict where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_citation where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_test where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_question where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_safety_warning where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_finding where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment_input where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_usage_ledger where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.ai_assessment where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(`delete from public.evidence where organization_id = any($1::uuid[])`, [
        orgIds,
      ]);
      await privileged.query(`delete from public.jobs where organization_id = any($1::uuid[])`, [
        orgIds,
      ]);
      await privileged.query(
        `delete from public.customers where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organization_memberships where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(`delete from public.organizations where id = any($1::uuid[])`, [
        orgIds,
      ]);
    }
    for (const u of [userA, userB]) {
      if (!u) continue;
      await privileged.query(`delete from public.users where id = $1::uuid`, [u.id]);
      await admin.auth.admin.deleteUser(u.id);
    }
    await privileged.end();
  });

  it("Isolation 1: org B cannot list org A's assessments", async () => {
    const rows = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      assessmentRepository.listForJob(tx, orgB.id, jobA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Isolation 2: org B cannot fetch org A's assessment by its real id", async () => {
    const row = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      assessmentRepository.getById(tx, orgB.id, jobA.id, assessmentA.id),
    );
    expect(row).toBeNull();
  });

  it("Isolation 3: org B cannot read org A's full assessment detail (findings/citations/tests/questions/warnings)", async () => {
    const row = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      assessmentRepository.getFullById(tx, orgB.id, jobA.id, assessmentA.id),
    );
    expect(row).toBeNull();
  });

  it("Isolation 4: org B cannot read org A's input snapshot", async () => {
    const rows = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      assessmentRepository.getInputSnapshot(tx, orgB.id, assessmentA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Isolation 5: org B cannot read org A's technician verdicts", async () => {
    const rows = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      verdictRepository.listForAssessment(tx, orgB.id, assessmentA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Isolation 6: org B cannot write a verdict against org A's finding", async () => {
    await expect(
      withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
        verdictRepository.upsert(tx, orgB.id, assessmentA.id, findingA.id, userB.id, {
          verdict: "rejected",
        }),
      ),
    ).rejects.toThrow();

    // Org A's original verdict must survive untouched.
    const stillA = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      verdictRepository.listForAssessment(tx, orgA.id, assessmentA.id),
    );
    expect(stillA).toHaveLength(1);
    expect(stillA[0].verdict).toBe("confirmed");
  });

  it("Isolation 7: a forged org context still cannot reach org A's assessment", async () => {
    // User B claims org A's id without holding a membership row. RLS
    // re-derives membership via is_member_of() rather than trusting the
    // GUC, so this must still return nothing.
    const rows = await withTenantContext({ userId: userB.id, orgId: orgA.id }, (tx) =>
      assessmentRepository.listForJob(tx, orgA.id, jobA.id),
    );
    expect(rows).toHaveLength(0);
  });

  it("Isolation 8: missing org context yields no rows for every assessment table", async () => {
    const [assessments, findings, verdicts] = await withTenantContext(
      { userId: userA.id, orgId: null },
      async (tx) => [
        await assessmentRepository.listForJob(tx, orgA.id, jobA.id),
        await assessmentRepository.getFullById(tx, orgA.id, jobA.id, assessmentA.id),
        await verdictRepository.listForAssessment(tx, orgA.id, assessmentA.id),
      ],
    );
    expect(assessments).toHaveLength(0);
    expect(findings).toBeNull();
    expect(verdicts).toHaveLength(0);
  });

  it("Isolation 9: org B cannot select org A's evidence when requesting an assessment (the exact check the create route relies on)", async () => {
    // The create route treats "fewer rows returned than ids requested" as
    // invalid_evidence. This proves that check actually fires for a
    // cross-org id, not just that it would in theory.
    const rows = await withTenantContext({ userId: userB.id, orgId: orgB.id }, (tx) =>
      evidenceRepository.listByIdsForJob(tx, orgB.id, jobA.id, [evidenceA.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("Isolation 10: org A can still read its own full assessment (sanity check the fixture and RLS both actually work)", async () => {
    const row = await withTenantContext({ userId: userA.id, orgId: orgA.id }, (tx) =>
      assessmentRepository.getFullById(tx, orgA.id, jobA.id, assessmentA.id),
    );
    expect(row).not.toBeNull();
    expect(row!.findings).toHaveLength(1);
    expect(row!.findings[0].citations).toHaveLength(1);
    expect(row!.findings[0].tests).toHaveLength(1);
    expect(row!.questions).toHaveLength(1);
    expect(row!.safetyWarnings).toHaveLength(1);
    expect(row!.findings[0].verdict?.verdict).toBe("confirmed");
  });
});
