import { createHash } from "node:crypto";
import { z } from "zod";
import { withResumedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import {
  assessmentRepository,
  type MarkFailedInput,
  type ResolvedFinding,
  type ResolvedQuestion,
  type InputSnapshotRow,
} from "@/lib/db/repositories/assessmentRepository";
import { downloadEvidenceObjectAsSystem } from "@/lib/storage/evidenceStorageSystem";
import {
  assignOrdinalRefs,
  resolveCitedEvidence,
  CitationResolutionError,
} from "@/lib/ai/citations";
import {
  modelOutputSchema,
  type ModelOutput,
  type SafetyCategory,
} from "@/lib/validation/assessment";
import { applySafetyRules } from "@/lib/ai/safetyRules";
import {
  assertImageCountWithinLimit,
  assertImageWithinLimits,
  assertTotalWithinLimit,
  ImagePayloadError,
} from "@/lib/ai/imagePayload";
import { SYSTEM_PROMPT } from "@/lib/ai/tool";
import { AnthropicAssessmentModel } from "@/lib/ai/anthropicModel";
import {
  AssessmentModelError,
  type AssessmentImageInput,
  type AssessmentModelPort,
} from "@/lib/ai/modelPort";

export type ExecutorTarget = {
  organizationId: string;
  assessmentId: string;
  requestedByUserId: string;
};

export type ModelFactory = (modelId: string) => AssessmentModelPort;

const defaultModelFactory: ModelFactory = (modelId) =>
  new AnthropicAssessmentModel(modelId);

class ExecutorFatalError extends Error {
  constructor(
    public readonly category: MarkFailedInput["category"],
    message: string,
    public readonly rawResponse?: unknown,
    public readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = "ExecutorFatalError";
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runs one queued assessment to completion (or to a recorded failure).
 * Deployment-agnostic and self-contained: it takes no Next.js request
 * context and depends on nothing session-scoped, because it may be
 * invoked with none available (an external cron, a queue drain, a
 * retry) -- see lib/auth/session.ts's withResumedOrgContext and
 * lib/storage/evidenceStorageSystem.ts for how it authenticates instead.
 *
 * Structured as claim -> fetch+verify -> snapshot -> model call ->
 * validate -> resolve citations -> safety rules -> persist, with each DB
 * step in its own short transaction and no transaction held open across
 * network I/O (Storage fetch, model call) -- see the inline step
 * comments. Idempotent: calling this twice for the same assessment is
 * safe, because the second call's claim finds status != 'queued' and
 * returns immediately.
 */
export async function runQueuedAssessment(
  target: ExecutorTarget,
  modelFactory: ModelFactory = defaultModelFactory,
): Promise<void> {
  const { organizationId, assessmentId, requestedByUserId } = target;

  // Step 1: atomic claim (DB only, fast).
  const claimed = await withResumedOrgContext(requestedByUserId, organizationId, (tx) =>
    assessmentRepository.claimForRun(tx, organizationId, assessmentId),
  );
  if (!claimed) return; // already claimed, or not queued -- idempotent no-op

  try {
    // Step 2: load job + verify the selected evidence still resolves
    // (DB only, fast).
    const { job, evidenceRows } = await withResumedOrgContext(
      requestedByUserId,
      organizationId,
      async (tx) => {
        const job = await jobRepository.getById(tx, organizationId, claimed.jobId);
        if (!job) {
          throw new ExecutorFatalError("unknown", "The job for this assessment no longer exists.");
        }
        const evidenceRows = await evidenceRepository.listByIdsForJob(
          tx,
          organizationId,
          claimed.jobId,
          claimed.selectedEvidenceIds,
        );
        return { job, evidenceRows };
      },
    );

    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
    const orderedEvidence = claimed.selectedEvidenceIds.map((id) => evidenceById.get(id));
    if (orderedEvidence.some((e) => e === undefined)) {
      throw new ExecutorFatalError(
        "unknown",
        "One or more selected photos are no longer available (deleted or not ready).",
      );
    }
    const evidenceList = orderedEvidence as NonNullable<(typeof orderedEvidence)[number]>[];

    // Step 3: fetch bytes, verify sha256, and enforce the server-side
    // payload limits (network, outside any transaction -- see
    // lib/storage/evidenceStorageSystem.ts for why this uses the narrow
    // system-level read rather than a session-scoped signed URL).
    //
    // The count is knowable before any download, so it is checked first.
    // This duplicates the create route's own cap deliberately: the executor
    // reads selectedEvidenceIds back from the database and must not depend
    // on whichever code path wrote it having been the one that validated it.
    assertImageCountWithinLimit(evidenceList.length);

    const assignment = assignOrdinalRefs(evidenceList.map((e) => e.id));
    const images: AssessmentImageInput[] = [];
    const inputRows: InputSnapshotRow[] = [];
    let totalImageBytes = 0;

    for (const [index, evidence] of evidenceList.entries()) {
      const bytes = await downloadEvidenceObjectAsSystem(evidence.storageKey);
      const computedHash = sha256Hex(bytes);
      if (evidence.clientSha256 && computedHash !== evidence.clientSha256) {
        throw new ExecutorFatalError(
          "sha_mismatch",
          `Evidence ${evidence.id} failed integrity verification: stored bytes do not match the recorded hash.`,
        );
      }
      // Size and format are judged on the bytes just fetched and hashed --
      // never on the row's client-asserted byteSize/mimeType -- and before
      // the base64 encoding below, since there is no reason to pay to encode
      // a payload we have already decided not to send. mediaType comes back
      // derived from those verified bytes, so what is announced to the model
      // is what was actually checked. Both limits are applied inside the
      // loop so an oversized set stops at the image that crossed the budget
      // instead of pulling every remaining object into memory first.
      const mediaType = assertImageWithinLimits(evidence.id, evidence.mimeType, bytes);
      totalImageBytes += bytes.byteLength;
      assertTotalWithinLimit(totalImageBytes);

      const ref = assignment[index].ordinalRef;
      images.push({
        ref,
        mediaType,
        base64: Buffer.from(bytes).toString("base64"),
      });
      inputRows.push({ evidenceId: evidence.id, ordinalRef: ref, sha256Verified: computedHash });
    }

    // Step 4: write the verified input snapshot (DB only, fast). This is
    // the anchor the citation-integrity constraint depends on -- see
    // ai_assessment_citation's composite FK.
    await withResumedOrgContext(requestedByUserId, organizationId, (tx) =>
      assessmentRepository.createInputSnapshot(tx, organizationId, assessmentId, inputRows),
    );

    // Step 5: the model call (network, slow, outside any transaction).
    const model = modelFactory(claimed.modelId);
    const modelResult = await model.run({
      systemPrompt: SYSTEM_PROMPT,
      jobContext: { title: job.title, problemDescription: job.problemDescription },
      images,
    }).catch((err) => {
      throw new ExecutorFatalError(
        "model_error",
        err instanceof AssessmentModelError || err instanceof Error
          ? err.message
          : "Model call failed",
      );
    });

    // Step 6: validate the response shape (pure). Forced strict tool use
    // makes this pass in the overwhelming majority of calls; this is the
    // backstop, not the primary mechanism.
    let output: ModelOutput;
    try {
      output = modelOutputSchema.parse(modelResult.payload);
    } catch (err) {
      throw new ExecutorFatalError(
        "schema_violation",
        err instanceof z.ZodError ? err.message : "Model output failed schema validation",
        modelResult.rawResponse,
        modelResult.usage,
      );
    }

    // Step 7: resolve every cited E-ref against the snapshot (pure). Any
    // ref the model cited that was not actually sent fails the entire
    // run here -- before anything is written -- rather than persisting a
    // finding with a citation the database would reject anyway.
    let resolvedFindings: ResolvedFinding[];
    try {
      resolvedFindings = [
        ...output.observations.map(
          (o): ResolvedFinding => ({
            ref: o.ref,
            kind: "observation",
            statement: o.statement,
            confidence: o.confidence,
            rationale: o.rationale,
            whatWouldChangeMyMind: null,
            safetyCategories: [],
            citedEvidenceIds: resolveCitedEvidence(assignment, o.citedEvidence),
            tests: [],
          }),
        ),
        ...output.hypotheses.map(
          (h): ResolvedFinding => ({
            ref: h.ref,
            kind: "hypothesis",
            statement: h.statement,
            confidence: h.confidence,
            rationale: h.rationale,
            whatWouldChangeMyMind: h.whatWouldChangeMyMind,
            safetyCategories: h.safetyCategories,
            citedEvidenceIds: resolveCitedEvidence(assignment, h.citedEvidence),
            tests: h.discriminatingTests,
          }),
        ),
      ];
    } catch (err) {
      if (err instanceof CitationResolutionError) {
        throw new ExecutorFatalError(
          "citation_violation",
          err.message,
          modelResult.rawResponse,
          modelResult.usage,
        );
      }
      throw err;
    }

    // Step 8: deterministic safety rules (pure, no model involvement).
    const safetyWarnings = applySafetyRules(
      resolvedFindings.map((f) => ({
        kind: f.kind,
        safetyCategories: f.safetyCategories as SafetyCategory[],
      })),
    );

    const resolvedQuestions: ResolvedQuestion[] = output.followUpQuestions.map((q) => ({
      question: q.question,
      whyItMatters: q.whyItMatters,
      answersWouldRuleIn: q.answersWouldRuleIn,
    }));

    // Step 9: persist everything for this run in one transaction, then
    // record usage. If any write here fails (most importantly, the
    // citation composite-FK insert), the whole transaction rolls back --
    // findings, tests, questions, warnings, and the status transition all
    // fail together, so a bad response never becomes a partially visible
    // assessment.
    await withResumedOrgContext(requestedByUserId, organizationId, async (tx) => {
      if (output.overallStatus === "insufficient_evidence") {
        await assessmentRepository.persistInsufficientEvidence(tx, organizationId, assessmentId, {
          insufficientReason:
            output.insufficientReason ?? "The model reported insufficient evidence.",
          limitations: output.limitations,
          safetyWarnings,
          usage: modelResult.usage,
          stopReason: modelResult.stopReason,
          latencyMs: modelResult.latencyMs,
          rawResponse: modelResult.rawResponse,
        });
      } else {
        await assessmentRepository.persistComplete(tx, organizationId, assessmentId, {
          findings: resolvedFindings,
          questions: resolvedQuestions,
          limitations: output.limitations,
          safetyWarnings,
          usage: modelResult.usage,
          stopReason: modelResult.stopReason,
          latencyMs: modelResult.latencyMs,
          rawResponse: modelResult.rawResponse,
        });
      }
      await assessmentRepository.recordUsage(
        tx,
        organizationId,
        assessmentId,
        claimed.modelId,
        modelResult.usage,
        true,
      );
    });
  } catch (err) {
    const failure = toExecutorFailure(err);
    // Called with no findings on purpose. A failed run means the model
    // never established anything, so the only warnings that can honestly
    // be attached are the deterministic baseline precautions -- and
    // because applySafetyRules only emits a category warning while
    // iterating the findings it was given, an empty list makes an
    // AI-derived hazard structurally unreachable here rather than merely
    // absent by convention.
    //
    // The failure itself is never treated as evidence of a hazard: a
    // model timeout or an oversized photo says nothing about the
    // installation, and inferring one would invent a fact from an outage.
    const safetyWarnings = applySafetyRules([]);
    await withResumedOrgContext(requestedByUserId, organizationId, async (tx) => {
      await assessmentRepository.markFailed(tx, organizationId, assessmentId, {
        category: failure.category,
        message: failure.message,
        rawResponse: failure.rawResponse,
        safetyWarnings,
      });
      await assessmentRepository.recordUsage(
        tx,
        organizationId,
        assessmentId,
        claimed.modelId,
        failure.usage ?? { inputTokens: 0, outputTokens: 0 },
        false,
      );
    }).catch((markFailedErr) => {
      // Last resort: even this failed (e.g. the database is briefly
      // unreachable). Not silently lost -- the row is still `running`
      // with a stale claimed_at, so the reaper will eventually catch it
      // and mark it failed with category=timeout instead.
      console.error("assessment executor: failed to record failure", {
        assessmentId,
        organizationId,
        originalError: err,
        markFailedError: markFailedErr,
      });
    });
  }
}

function toExecutorFailure(err: unknown): {
  category: MarkFailedInput["category"];
  message: string;
  rawResponse?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
} {
  if (err instanceof ExecutorFatalError) {
    return {
      category: err.category,
      message: err.message,
      rawResponse: err.rawResponse,
      usage: err.usage,
    };
  }
  // Payload governance carries its own category so a request this
  // application declined to make is never reported as a provider failure.
  // These runs cost zero tokens -- recordUsage below writes 0/0 -- but the
  // AiAssessment row still counts against the monthly quota exactly as
  // every other attempt does. That stays correct without special-casing:
  // a payload rejection is deterministic, so retrying the same photos can
  // never be a quota-bypass vector, and quota enforcement continues to
  // count rows rather than depending on the ledger (see lib/ai/quota.ts).
  if (err instanceof ImagePayloadError) {
    return { category: err.category, message: err.message };
  }
  if (err instanceof AssessmentModelError) {
    return { category: "model_error", message: err.message };
  }
  return {
    category: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}
