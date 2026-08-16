import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { createAssessmentSchema } from "@/lib/validation/assessment";
import { PROMPT_VERSION, SCHEMA_VERSION } from "@/lib/ai/tool";
import { STANDARD_MODEL_ID, ESCALATION_MODEL_ID } from "@/lib/ai/anthropicModel";
import { MONTHLY_ASSESSMENT_QUOTA, isQuotaExceeded, nextBillingPeriodStart } from "@/lib/ai/quota";
import { runQueuedAssessment } from "@/lib/ai/executor";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const assessments = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      assessmentRepository.listForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ assessments });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Creates a queued assessment. Everything here is synchronous, fast, and
 * uses the caller's live session -- the slow, network-bound part (the
 * model call) is kicked off separately below and is never awaited by this
 * response (D1: async + polling).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createAssessmentSchema.parse(await request.json());

    const prepared = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const job = await jobRepository.getById(tx, ctx.orgId, jobId);
      if (!job) return { kind: "not_found" as const };

      // Every requested id must resolve to ready, non-deleted evidence in
      // THIS job -- if fewer rows come back than requested, at least one
      // id was invalid, belonged to a different job, or was deleted.
      const evidenceRows = await evidenceRepository.listByIdsForJob(
        tx,
        ctx.orgId,
        jobId,
        body.evidenceIds,
      );
      if (evidenceRows.length !== body.evidenceIds.length) {
        return { kind: "invalid_evidence" as const };
      }

      const usedThisMonth = await assessmentRepository.countThisMonth(tx, ctx.orgId);
      if (isQuotaExceeded(usedThisMonth)) {
        return { kind: "quota_exceeded" as const };
      }

      const version = await assessmentRepository.nextVersion(tx, ctx.orgId, jobId);
      // D2: escalation is an explicit technician action, never automatic.
      const modelTier = body.escalate ? ("escalation" as const) : ("standard" as const);
      const modelId = body.escalate ? ESCALATION_MODEL_ID : STANDARD_MODEL_ID;

      const assessment = await assessmentRepository.createQueued(tx, ctx.orgId, {
        jobId,
        requestedByUserId: ctx.userId,
        version,
        selectedEvidenceIds: body.evidenceIds,
        modelTier,
        modelId,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
      });
      return { kind: "ok" as const, assessment, userId: ctx.userId, orgId: ctx.orgId };
    });

    if (prepared.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (prepared.kind === "invalid_evidence") {
      return NextResponse.json({ error: "invalid_evidence" }, { status: 400 });
    }
    if (prepared.kind === "quota_exceeded") {
      return NextResponse.json(
        {
          error: "quota_exceeded",
          limit: MONTHLY_ASSESSMENT_QUOTA,
          resetsAt: nextBillingPeriodStart().toISOString(),
        },
        { status: 409 },
      );
    }

    // Best-effort in-process kick. Never awaited -- the response must
    // return immediately, and this call is self-contained (see
    // lib/ai/executor.ts's use of withResumedOrgContext), so it does not
    // depend on this request's session surviving. If the host kills this
    // process the instant the response is sent, the assessment simply
    // stays `queued` for the internal drain endpoint or the next poll's
    // opportunistic reap to pick up -- see docs/architecture/ai-assessment.md.
    void runQueuedAssessment({
      organizationId: prepared.orgId,
      assessmentId: prepared.assessment.id,
      requestedByUserId: prepared.userId,
    }).catch((err) => {
      console.error("assessment in-process kick failed", err);
    });

    return NextResponse.json({ assessment: prepared.assessment }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
