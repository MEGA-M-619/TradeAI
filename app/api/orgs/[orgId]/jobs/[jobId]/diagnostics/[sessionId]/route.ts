import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { updateDiagnosticSessionSchema } from "@/lib/validation/diagnostics";
import { buildSafetyFacts } from "@/lib/safety/factBuilder";
import { evaluateSafety } from "@/lib/safety/evaluate";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; sessionId: string }>;
};

/**
 * Returns the session, its causes, and a safety evaluation computed from
 * the same transaction.
 *
 * The safety block is derived, never stored: it is recomputed on every
 * read from the facts as they stand at that moment, so a measurement
 * recorded after a previous read cannot leave a stale verdict on screen.
 * It is also strictly read-only -- buildSafetyFacts only reads, and
 * evaluateSafety is pure, so nothing here touches DiagnosticSession or
 * DiagnosticCandidateCause state.
 *
 * The facts come from verified route params inside the org-scoped
 * transaction; no request input contributes to them.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId, sessionId } = await params;
  try {
    const result = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const session = await diagnosticSessionRepository.getFullById(
        tx,
        ctx.orgId,
        jobId,
        sessionId,
      );
      if (!session) return null;

      const facts = await buildSafetyFacts(tx, ctx.orgId, jobId, sessionId);
      return { session, safety: evaluateSafety(facts) };
    });

    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Handles both the "edit symptom text" and "abandon" actions the approved
 * plan groups under one PATCH route -- see
 * lib/validation/diagnostics.ts's updateDiagnosticSessionSchema for why
 * `status` only ever accepts `"abandoned"` here. Both fields may be sent
 * together; each maps to its own repository call
 * (diagnosticSessionRepository has no single combined "update" function
 * on purpose -- editing the symptom never touches status, matching
 * diagnosticCauseRepository's separation of create from status-changing
 * update).
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, jobId, sessionId } = await params;
  try {
    const body = updateDiagnosticSessionSchema.parse(await request.json());

    const session = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        const existing = await diagnosticSessionRepository.getById(
          tx,
          ctx.orgId,
          jobId,
          sessionId,
        );
        if (!existing) return null;

        let current = existing;
        if (body.symptom !== undefined) {
          current = await diagnosticSessionRepository.updateSymptom(
            tx,
            ctx.orgId,
            jobId,
            sessionId,
            body.symptom,
          );
        }
        if (body.status === "abandoned") {
          current = await diagnosticSessionRepository.abandon(
            tx,
            ctx.orgId,
            jobId,
            sessionId,
          );
        }
        return current;
      },
    );

    if (!session) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    return handleApiError(error);
  }
}
