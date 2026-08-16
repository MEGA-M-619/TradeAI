import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { dbTestsEnabled, createAdminSupabaseClient, createPrivilegedPool } from "./helpers";
import { withTenantContext } from "@/lib/db/tenantContext";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { buildEvidenceKey, EVIDENCE_BUCKET } from "@/lib/storage/evidenceStorage";
import { runQueuedAssessment } from "@/lib/ai/executor";
import { FixtureAssessmentModel, makeResult } from "@/lib/ai/fixtureModel";

// The adversarial core of the Phase 3 test suite: exercises the real
// executor (lib/ai/executor.ts) end to end against a live Supabase
// project -- real Postgres RLS, a real Storage object, real sha256
// verification -- with a FixtureAssessmentModel standing in for the
// network call to Anthropic. This is deliberately NOT a test of model
// quality (see the opt-in eval harness for that); it proves that no
// fixture response, however adversarial, can ever result in a
// fabricated citation being persisted, a malformed response being
// accepted, or unverified bytes being sent onward.
describe.skipIf(!dbTestsEnabled)("assessment executor", () => {
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let user: { id: string; email: string };
  let org: { id: string };
  let job: { id: string };
  let evidenceGood: { id: string; storageKey: string };
  let evidenceBad: { id: string; storageKey: string };

  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const REAL_SHA256 = createHash("sha256").update(PNG).digest("hex");

  const createdAssessmentIds: string[] = [];

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const email = `tradeai-exec-${randomUUID()}@example.invalid`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("user create failed");
    user = { id: data.user.id, email };
    await userRepository.ensureProfile(user.id, user.email);

    org = await organizationRepository.create(user.id, "Executor Test Org");
    const customer = await withTenantContext({ userId: user.id, orgId: org.id }, (tx) =>
      customerRepository.create(tx, org.id, { name: "Executor Fixture Customer" }),
    );
    job = await withTenantContext({ userId: user.id, orgId: org.id }, (tx) =>
      jobRepository.create(tx, org.id, user.id, { customerId: customer.id, title: "Executor test job" }),
    );

    // A real object in Storage, uploaded via the service role for test
    // setup only (matching the established pattern) -- the executor's
    // own download path (lib/storage/evidenceStorageSystem.ts) is what
    // is actually under test, not this upload.
    const goodId = randomUUID();
    const goodKey = buildEvidenceKey(org.id, job.id, goodId);
    await admin.storage.from(EVIDENCE_BUCKET).upload(goodKey, PNG, { contentType: "image/jpeg" });
    evidenceGood = { id: goodId, storageKey: goodKey };
    await withTenantContext({ userId: user.id, orgId: org.id }, async (tx) => {
      await evidenceRepository.create(tx, org.id, {
        id: goodId, jobId: job.id, uploadedByUserId: user.id, storageKey: goodKey, mimeType: "image/jpeg",
      });
      await evidenceRepository.markReady(tx, org.id, job.id, goodId, { byteSize: PNG.length, clientSha256: REAL_SHA256 });
    });

    // A second evidence row whose recorded clientSha256 does NOT match
    // the actual uploaded bytes -- the sha-mismatch adversarial case.
    const badId = randomUUID();
    const badKey = buildEvidenceKey(org.id, job.id, badId);
    await admin.storage.from(EVIDENCE_BUCKET).upload(badKey, PNG, { contentType: "image/jpeg" });
    evidenceBad = { id: badId, storageKey: badKey };
    await withTenantContext({ userId: user.id, orgId: org.id }, async (tx) => {
      await evidenceRepository.create(tx, org.id, {
        id: badId, jobId: job.id, uploadedByUserId: user.id, storageKey: badKey, mimeType: "image/jpeg",
      });
      await evidenceRepository.markReady(tx, org.id, job.id, badId, {
        byteSize: PNG.length,
        clientSha256: "0".repeat(64), // deliberately wrong
      });
    });
  });

  afterEach(async () => {
    // Each test creates its own assessment; clean up after every test so
    // version numbers and quota counts don't bleed between cases.
    if (createdAssessmentIds.length === 0) return;
    await privileged.query(`delete from public.technician_verdict where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_citation where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_test where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_question where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_safety_warning where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_finding where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment_input where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_usage_ledger where assessment_id = any($1::uuid[])`, [createdAssessmentIds]);
    await privileged.query(`delete from public.ai_assessment where id = any($1::uuid[])`, [createdAssessmentIds]);
    createdAssessmentIds.length = 0;
  });

  afterAll(async () => {
    await admin.storage.from(EVIDENCE_BUCKET).remove([evidenceGood.storageKey, evidenceBad.storageKey]);
    await privileged.query(`delete from public.evidence where organization_id = $1::uuid`, [org.id]);
    await privileged.query(`delete from public.jobs where organization_id = $1::uuid`, [org.id]);
    await privileged.query(`delete from public.customers where organization_id = $1::uuid`, [org.id]);
    await privileged.query(`delete from public.organization_memberships where organization_id = $1::uuid`, [org.id]);
    await privileged.query(`delete from public.organizations where id = $1::uuid`, [org.id]);
    await privileged.query(`delete from public.users where id = $1::uuid`, [user.id]);
    await admin.auth.admin.deleteUser(user.id);
    await privileged.end();
  });

  async function createQueuedFor(evidenceIds: string[]) {
    return withTenantContext({ userId: user.id, orgId: org.id }, async (tx) => {
      const version = await assessmentRepository.nextVersion(tx, org.id, job.id);
      const assessment = await assessmentRepository.createQueued(tx, org.id, {
        jobId: job.id,
        requestedByUserId: user.id,
        version,
        selectedEvidenceIds: evidenceIds,
        modelTier: "standard",
        modelId: "claude-sonnet-5",
        promptVersion: "test",
        schemaVersion: "test",
      });
      createdAssessmentIds.push(assessment.id);
      return assessment;
    });
  }

  async function getAssessment(id: string) {
    return withTenantContext({ userId: user.id, orgId: org.id }, (tx) =>
      assessmentRepository.getFullById(tx, org.id, job.id, id),
    );
  }

  it("Executor 1: happy path -- valid response persists findings, citations, tests, questions, and safety warnings, and completes", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    const model = FixtureAssessmentModel.withPayload({
      overallStatus: "assessment_provided",
      observations: [
        { ref: "O1", statement: "Panel visible", citedEvidence: ["E1"], confidence: "high", rationale: "Clearly visible" },
      ],
      hypotheses: [
        {
          ref: "H1",
          statement: "Possible loose lug",
          citedEvidence: ["E1"],
          confidence: "medium",
          rationale: "Discoloration near terminal",
          whatWouldChangeMyMind: "A torque check at spec",
          discriminatingTests: [
            { test: "Torque check", rulesInIfPositive: "Confirms", rulesOutIfNegative: "Rules out" },
          ],
          safetyCategories: ["thermal_damage_scorching"],
        },
      ],
      followUpQuestions: [
        { question: "Has this tripped before?", whyItMatters: "Supports the hypothesis", answersWouldRuleIn: ["Yes"] },
      ],
      limitations: ["Image resolution limits fine detail"],
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("complete");
    expect(result?.findings).toHaveLength(2);
    const hypothesis = result!.findings.find((f) => f.kind === "hypothesis")!;
    expect(hypothesis.citations).toHaveLength(1);
    expect(hypothesis.citations[0].evidenceId).toBe(evidenceGood.id);
    expect(hypothesis.tests).toHaveLength(1);
    expect(result?.questions).toHaveLength(1);
    // Baseline warnings (3) + the triggered thermal_damage_scorching rule.
    expect(result?.safetyWarnings.length).toBeGreaterThanOrEqual(4);
    expect(result?.safetyWarnings.some((w) => w.ruleId === "category_thermal_damage_scorching")).toBe(true);
    expect(result?.inputTokens).toBe(500);
    expect(result?.outputTokens).toBe(300);
  });

  it("Executor 2: insufficient_evidence persists no findings and still carries baseline safety warnings", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    const model = FixtureAssessmentModel.withPayload({
      overallStatus: "insufficient_evidence",
      insufficientReason: "The photo does not show the panel interior.",
      observations: [],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("insufficient_evidence");
    expect(result?.insufficientReason).toBe("The photo does not show the panel interior.");
    expect(result?.findings).toHaveLength(0);
    expect(result?.safetyWarnings.length).toBeGreaterThanOrEqual(3);
  });

  it("Executor 3: ADVERSARIAL -- a fabricated citation (out-of-range ref) fails the whole run and persists nothing", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]); // only E1 exists
    const model = FixtureAssessmentModel.withPayload({
      overallStatus: "assessment_provided",
      observations: [
        // Cites E2, which was never sent -- only one image (E1) was provided.
        { ref: "O1", statement: "Fabricated observation", citedEvidence: ["E2"], confidence: "high", rationale: "x" },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("failed");
    expect(result?.failureCategory).toBe("citation_violation");
    expect(result?.findings).toHaveLength(0);

    const citationCount = await privileged.query(
      `select count(*)::int c from public.ai_assessment_citation where assessment_id = $1::uuid`,
      [assessment.id],
    );
    expect(citationCount.rows[0].c).toBe(0);
  });

  it("Executor 4: ADVERSARIAL -- a schema-violating response (missing required field) fails the run and persists nothing", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    const model = FixtureAssessmentModel.withPayload({
      overallStatus: "assessment_provided",
      observations: [],
      hypotheses: [
        {
          ref: "H1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "low",
          rationale: "x",
          // whatWouldChangeMyMind and discriminatingTests deliberately omitted
          safetyCategories: [],
        },
      ],
      followUpQuestions: [],
      limitations: [],
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("failed");
    expect(result?.failureCategory).toBe("schema_violation");
    expect(result?.findings).toHaveLength(0);
  });

  it("Executor 5: ADVERSARIAL -- a response injecting an unrecognized field (e.g. a price) is stripped, not honored", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    const model = FixtureAssessmentModel.withPayload({
      overallStatus: "assessment_provided",
      observations: [
        {
          ref: "O1",
          statement: "x",
          citedEvidence: ["E1"],
          confidence: "high",
          rationale: "x",
          // The schema has no price/quantity field anywhere -- this must
          // be silently dropped by Zod's default stripping, not error and
          // not be persisted anywhere.
          estimatedCost: 450,
        },
      ],
      hypotheses: [],
      followUpQuestions: [],
      limitations: [],
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("complete");
    // rawResponse intentionally retains the model's payload verbatim for
    // provenance/debugging (see AiAssessment.rawResponse's doc comment),
    // so the injected field legitimately appears there. What must never
    // happen is that field reaching the structured, persisted finding --
    // the only place a UI or downstream consumer would actually read it
    // from.
    expect(JSON.stringify(result?.findings)).not.toContain("450");
    expect(JSON.stringify(result?.findings)).not.toContain("estimatedCost");
    expect(Object.keys(result!.findings[0])).not.toContain("estimatedCost");
  });

  it("Executor 6: ADVERSARIAL -- evidence with a sha256 that does not match the stored bytes fails before any model call", async () => {
    const assessment = await createQueuedFor([evidenceBad.id]);
    let modelCalled = false;
    const model = new FixtureAssessmentModel(() => {
      modelCalled = true;
      return makeResult({ overallStatus: "insufficient_evidence", insufficientReason: "x", observations: [], hypotheses: [], followUpQuestions: [], limitations: [] });
    });

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("failed");
    expect(result?.failureCategory).toBe("sha_mismatch");
    expect(modelCalled).toBe(false); // fails fast, before spending any model tokens

    const usage = await privileged.query(
      `select input_tokens, succeeded from public.ai_usage_ledger where assessment_id = $1::uuid`,
      [assessment.id],
    );
    expect(usage.rows[0].succeeded).toBe(false);
    expect(usage.rows[0].input_tokens).toBe(0);
  });

  it("Executor 7: claim is idempotent -- calling the executor twice for the same assessment only processes it once", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    let callCount = 0;
    const model = new FixtureAssessmentModel(() => {
      callCount += 1;
      return makeResult({
        overallStatus: "assessment_provided",
        observations: [{ ref: "O1", statement: "x", citedEvidence: ["E1"], confidence: "low", rationale: "x" }],
        hypotheses: [],
        followUpQuestions: [],
        limitations: [],
      });
    });

    const target = { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id };
    // Run twice, sequentially -- the second call's claim must be a no-op
    // because status is no longer 'queued'.
    await runQueuedAssessment(target, () => model);
    await runQueuedAssessment(target, () => model);

    expect(callCount).toBe(1);
    const result = await getAssessment(assessment.id);
    expect(result?.findings).toHaveLength(1);
  });

  it("Executor 8: a provider-level failure (network/API error) is recorded as model_error, not silently lost", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    const model = FixtureAssessmentModel.throwing(new Error("simulated network failure"));

    await runQueuedAssessment(
      { organizationId: org.id, assessmentId: assessment.id, requestedByUserId: user.id },
      () => model,
    );

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("failed");
    expect(result?.failureCategory).toBe("model_error");
  });

  it("Executor 9: a queued assessment never claimed and older than the queued timeout is reaped as failed/timeout", async () => {
    const assessment = await createQueuedFor([evidenceGood.id]);
    // Backdate created_at past the reaper's queued_timeout (15 min
    // default) using the privileged connection -- simulates a process
    // that queued the row and then crashed before ever claiming it.
    await privileged.query(
      `update public.ai_assessment set created_at = now() - interval '1 hour' where id = $1::uuid`,
      [assessment.id],
    );

    const reaped = await assessmentRepository.reapStuck();
    expect(reaped.some((r) => r.id === assessment.id)).toBe(true);

    const result = await getAssessment(assessment.id);
    expect(result?.status).toBe("failed");
    expect(result?.failureCategory).toBe("timeout");
  });

  it("Executor 10: a running assessment stuck past the running timeout is reaped, a fresh one is not", async () => {
    const stuck = await createQueuedFor([evidenceGood.id]);
    const fresh = await createQueuedFor([evidenceGood.id]);

    await withTenantContext({ userId: user.id, orgId: org.id }, (tx) =>
      assessmentRepository.claimForRun(tx, org.id, stuck.id),
    );
    await withTenantContext({ userId: user.id, orgId: org.id }, (tx) =>
      assessmentRepository.claimForRun(tx, org.id, fresh.id),
    );
    await privileged.query(
      `update public.ai_assessment set claimed_at = now() - interval '1 hour' where id = $1::uuid`,
      [stuck.id],
    );

    const reaped = await assessmentRepository.reapStuck();
    const reapedIds = reaped.map((r) => r.id);
    expect(reapedIds).toContain(stuck.id);
    expect(reapedIds).not.toContain(fresh.id);

    const freshResult = await getAssessment(fresh.id);
    expect(freshResult?.status).toBe("running");
  });
});
