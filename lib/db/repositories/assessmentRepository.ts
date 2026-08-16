import type { TenantTxClient } from "@/lib/db/tenantContext";
import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import { currentBillingPeriodStart, currentBillingPeriod } from "@/lib/ai/quota";
import type { SafetyWarning } from "@/lib/ai/safetyRules";

export type CreateQueuedInput = {
  jobId: string;
  requestedByUserId: string;
  version: number;
  selectedEvidenceIds: string[];
  modelTier: "standard" | "escalation";
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
};

export type InputSnapshotRow = {
  evidenceId: string;
  ordinalRef: string;
  sha256Verified: string;
};

export type ResolvedTest = {
  test: string;
  rulesInIfPositive: string;
  rulesOutIfNegative: string;
};

export type ResolvedFinding = {
  ref: string;
  kind: "observation" | "hypothesis";
  statement: string;
  confidence: "low" | "medium" | "high";
  rationale: string;
  whatWouldChangeMyMind: string | null;
  safetyCategories: string[];
  /** Already resolved from E-refs to real evidence ids -- see
   * lib/ai/citations.ts. persistComplete never sees an E-ref. */
  citedEvidenceIds: string[];
  tests: ResolvedTest[];
};

export type ResolvedQuestion = {
  question: string;
  whyItMatters: string;
  answersWouldRuleIn: string[];
};

export type PersistCompleteInput = {
  findings: ResolvedFinding[];
  questions: ResolvedQuestion[];
  safetyWarnings: SafetyWarning[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  latencyMs: number;
  rawResponse: unknown;
};

export type PersistInsufficientInput = {
  insufficientReason: string;
  safetyWarnings: SafetyWarning[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  latencyMs: number;
  rawResponse: unknown;
};

export type MarkFailedInput = {
  category:
    | "quota_exceeded"
    | "sha_mismatch"
    | "model_error"
    | "schema_violation"
    | "citation_violation"
    | "timeout"
    | "unknown";
  message: string;
  rawResponse?: unknown;
};

/**
 * All tenant-scoped Prisma access for the nine Phase 3 tables must go
 * through this module (plus verdictRepository for technician_verdict) --
 * never `prisma.aiAssessment.*` etc. directly elsewhere (see the
 * no-restricted-syntax rule in eslint.config.mjs). Every function requires
 * an already org-scoped transaction client, from either
 * withAuthenticatedOrgContext (live request) or withResumedOrgContext (the
 * executor, resuming a previously-verified identity -- see
 * lib/auth/session.ts).
 */
export const assessmentRepository = {
  /** Every attempt counts, including ones that go on to fail -- a failed
   * run still cost tokens, and failed-retry loops must not bypass the
   * cap. See lib/ai/quota.ts. */
  async countThisMonth(tx: TenantTxClient, orgId: string): Promise<number> {
    return tx.aiAssessment.count({
      where: { organizationId: orgId, createdAt: { gte: currentBillingPeriodStart() } },
    });
  },

  async nextVersion(tx: TenantTxClient, orgId: string, jobId: string): Promise<number> {
    const last = await tx.aiAssessment.findFirst({
      where: { organizationId: orgId, jobId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return (last?.version ?? 0) + 1;
  },

  async createQueued(tx: TenantTxClient, orgId: string, data: CreateQueuedInput) {
    return tx.aiAssessment.create({
      data: {
        organizationId: orgId,
        jobId: data.jobId,
        requestedByUserId: data.requestedByUserId,
        version: data.version,
        status: "queued",
        modelTier: data.modelTier,
        modelId: data.modelId,
        promptVersion: data.promptVersion,
        schemaVersion: data.schemaVersion,
        selectedEvidenceIds: data.selectedEvidenceIds,
      },
    });
  },

  /**
   * Atomic claim: transitions queued -> running only if it is still
   * queued. Two concurrent callers (the in-process kick and an external
   * drain hitting the same row) racing this can only ever have one
   * winner -- the loser gets Prisma's P2025 (no row matched the filtered
   * where) and should treat that as "already being handled," not an
   * error. See lib/ai/executor.ts.
   */
  async claimForRun(tx: TenantTxClient, orgId: string, assessmentId: string) {
    try {
      return await tx.aiAssessment.update({
        where: { id: assessmentId, organizationId: orgId, status: "queued" },
        data: { status: "running", claimedAt: new Date() },
      });
    } catch (err) {
      if (isRecordNotFoundError(err)) return null;
      throw err;
    }
  },

  async createInputSnapshot(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    rows: InputSnapshotRow[],
  ): Promise<void> {
    await tx.aiAssessmentInput.createMany({
      data: rows.map((r) => ({
        assessmentId,
        organizationId: orgId,
        evidenceId: r.evidenceId,
        ordinalRef: r.ordinalRef,
        sha256Verified: r.sha256Verified,
      })),
    });
  },

  async getInputSnapshot(tx: TenantTxClient, orgId: string, assessmentId: string) {
    return tx.aiAssessmentInput.findMany({
      where: { assessmentId, organizationId: orgId },
      orderBy: { ordinalRef: "asc" },
    });
  },

  async getById(tx: TenantTxClient, orgId: string, jobId: string, assessmentId: string) {
    return tx.aiAssessment.findFirst({
      where: { id: assessmentId, organizationId: orgId, jobId },
    });
  },

  /** Scoped by assessmentId (not just id) so a valid finding id from a
   * different assessment in the same org can't be addressed through the
   * wrong assessment's verdict endpoint. */
  async getFindingById(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    findingId: string,
  ) {
    return tx.aiAssessmentFinding.findFirst({
      where: { id: findingId, assessmentId, organizationId: orgId },
    });
  },

  async listForJob(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.aiAssessment.findMany({
      where: { organizationId: orgId, jobId },
      orderBy: { version: "desc" },
    });
  },

  /** Full detail view: findings with their citations/tests/verdict,
   * questions, safety warnings. Used by the assessment detail endpoint. */
  async getFullById(tx: TenantTxClient, orgId: string, jobId: string, assessmentId: string) {
    return tx.aiAssessment.findFirst({
      where: { id: assessmentId, organizationId: orgId, jobId },
      include: {
        findings: {
          include: { citations: true, tests: true, verdict: true },
          orderBy: { createdAt: "asc" },
        },
        questions: { orderBy: { createdAt: "asc" } },
        safetyWarnings: { orderBy: { createdAt: "asc" } },
      },
    });
  },

  /**
   * The all-or-nothing write. Every insert below runs inside the same
   * transaction the caller already opened (withResumedOrgContext), so a
   * fabricated citation's foreign-key violation on the LAST insert rolls
   * back everything already written in this call -- findings, tests,
   * questions, safety warnings, and the status transition all fail
   * together. A response containing even one bad citation therefore never
   * becomes a partially-visible assessment.
   */
  async persistComplete(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    input: PersistCompleteInput,
  ): Promise<void> {
    const testRows: Prisma.AiAssessmentTestCreateManyInput[] = [];
    const citationRows: Prisma.AiAssessmentCitationCreateManyInput[] = [];

    for (const finding of input.findings) {
      const created = await tx.aiAssessmentFinding.create({
        data: {
          assessmentId,
          organizationId: orgId,
          kind: finding.kind,
          ref: finding.ref,
          statement: finding.statement,
          confidence: finding.confidence,
          rationale: finding.rationale,
          whatWouldChangeMyMind: finding.whatWouldChangeMyMind,
          safetyCategories: finding.safetyCategories,
        },
      });

      for (const evidenceId of finding.citedEvidenceIds) {
        citationRows.push({
          assessmentId,
          organizationId: orgId,
          findingId: created.id,
          evidenceId,
        });
      }
      for (const test of finding.tests) {
        testRows.push({
          assessmentId,
          organizationId: orgId,
          findingId: created.id,
          test: test.test,
          rulesInIfPositive: test.rulesInIfPositive,
          rulesOutIfNegative: test.rulesOutIfNegative,
        });
      }
    }

    // Citations last, deliberately: this is the insert whose failure
    // (a fabricated or cross-run evidence id) must roll back everything
    // above it in this same transaction.
    if (testRows.length) await tx.aiAssessmentTest.createMany({ data: testRows });
    if (input.questions.length) {
      await tx.aiAssessmentQuestion.createMany({
        data: input.questions.map((q) => ({
          assessmentId,
          organizationId: orgId,
          question: q.question,
          whyItMatters: q.whyItMatters,
          answersWouldRuleIn: q.answersWouldRuleIn,
        })),
      });
    }
    await tx.aiAssessmentSafetyWarning.createMany({
      data: input.safetyWarnings.map((w) => ({
        assessmentId,
        organizationId: orgId,
        ruleId: w.ruleId,
        severity: w.severity,
        message: w.message,
      })),
    });
    if (citationRows.length) {
      await tx.aiAssessmentCitation.createMany({ data: citationRows });
    }

    await tx.aiAssessment.update({
      where: { id: assessmentId, organizationId: orgId },
      data: {
        status: "complete",
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        latencyMs: input.latencyMs,
        stopReason: input.stopReason,
        rawResponse: input.rawResponse as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  },

  async persistInsufficientEvidence(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    input: PersistInsufficientInput,
  ): Promise<void> {
    await tx.aiAssessmentSafetyWarning.createMany({
      data: input.safetyWarnings.map((w) => ({
        assessmentId,
        organizationId: orgId,
        ruleId: w.ruleId,
        severity: w.severity,
        message: w.message,
      })),
    });
    await tx.aiAssessment.update({
      where: { id: assessmentId, organizationId: orgId },
      data: {
        status: "insufficient_evidence",
        insufficientReason: input.insufficientReason,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        latencyMs: input.latencyMs,
        stopReason: input.stopReason,
        rawResponse: input.rawResponse as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  },

  async markFailed(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string,
    input: MarkFailedInput,
  ): Promise<void> {
    await tx.aiAssessment.update({
      where: { id: assessmentId, organizationId: orgId },
      data: {
        status: "failed",
        failureCategory: input.category,
        errorMessage: input.message,
        rawResponse:
          input.rawResponse !== undefined
            ? (input.rawResponse as Prisma.InputJsonValue)
            : undefined,
        completedAt: new Date(),
      },
    });
  },

  async recordUsage(
    tx: TenantTxClient,
    orgId: string,
    assessmentId: string | null,
    modelId: string,
    tokens: { inputTokens: number; outputTokens: number },
    succeeded: boolean,
  ): Promise<void> {
    await tx.aiUsageLedger.create({
      data: {
        organizationId: orgId,
        assessmentId,
        billingPeriod: currentBillingPeriod(),
        modelId,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        succeeded,
      },
    });
  },

  /**
   * Reaps assessments stuck past their timeout, across every organization.
   * Deliberately NOT called through withTenantContext/withResumedOrgContext:
   * it is not a single tenant's operation, and no org context could make
   * sense for a query that spans all of them. It goes through the
   * SECURITY DEFINER function reap_stuck_ai_assessments() (see
   * prisma/migrations/20260817000011_ai_assessment_reaper), which is safe
   * to call this way because it is narrowly scoped, content-blind, and
   * owned by the migration role -- not because this bypasses tenant
   * isolation for tenant content, which it never touches.
   */
  async reapStuck(): Promise<{ id: string; organizationId: string }[]> {
    const rows = await prisma.$queryRaw<{ id: string; organization_id: string }[]>`
      select * from public.reap_stuck_ai_assessments()
    `;
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id }));
  },

  /** Cross-tenant queue discovery for the internal drain endpoint -- see
   * reapStuck() above for why this bypasses the normal tenant-scoped
   * transaction pattern, and prisma/migrations/20260817000012_ai_assessment_queue
   * for the function this calls. */
  async drainQueue(
    maxRows: number,
  ): Promise<{ id: string; organizationId: string; requestedByUserId: string }[]> {
    const rows = await prisma.$queryRaw<
      { id: string; organization_id: string; requested_by_user_id: string }[]
    >`select * from public.list_queued_ai_assessments(${maxRows})`;
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      requestedByUserId: r.requested_by_user_id,
    }));
  },
};

function isRecordNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2025"
  );
}
