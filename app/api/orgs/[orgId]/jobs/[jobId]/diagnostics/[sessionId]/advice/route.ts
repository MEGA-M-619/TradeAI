import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { requestDiagnosticAdvice } from "@/lib/ai/advisor/service";
import { advisorRequestSchema } from "@/lib/validation/advisor";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; sessionId: string }>;
};

/**
 * Asks the diagnostic advisor about one session.
 *
 * POST rather than GET because it spends money and is explicitly
 * user-triggered -- never fired by a render, a poll, or a keystroke.
 *
 * Authorization is the same chokepoint every other route uses:
 * withAuthenticatedOrgContext verifies the session, re-derives membership
 * from the database, and opens an RLS-scoped transaction. The context the
 * model sees is then built inside that transaction from route params
 * only, so a caller cannot reach another organization's session by
 * supplying its id -- the read simply returns nothing and this responds
 * 404, exactly as the non-AI routes do.
 *
 * Every AI failure is a normal response, not a 500: the deterministic
 * workflow is unaffected by the advisor being down, and the UI needs to
 * say which kind of failure happened without implying anything about the
 * electrical situation.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId, sessionId } = await params;
  try {
    const body = advisorRequestSchema.parse(
      await request.json().catch(() => ({})),
    );

    const outcome = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      requestDiagnosticAdvice(
        tx,
        ctx.orgId,
        jobId,
        sessionId,
        body.question ?? null,
      ),
    );

    switch (outcome.status) {
      case "not_found":
        return NextResponse.json({ error: "not_found" }, { status: 404 });

      case "unavailable":
        // 503: the job is fine, the advisor is not.
        return NextResponse.json(
          { error: "advisor_unavailable", reason: outcome.reason },
          { status: 503 },
        );

      case "ungrounded":
        // 502: the provider answered, but not with something that can be
        // trusted. Reported distinctly from an outage so the UI does not
        // tell the technician to "try again" when retrying is unlikely to
        // help, and so the problems are visible in logs.
        return NextResponse.json(
          {
            error: "advisor_ungrounded",
            reason: outcome.reason,
            problems: outcome.problems,
          },
          { status: 502 },
        );

      case "ok":
        return NextResponse.json({
          advice: outcome.advice,
          modelId: outcome.modelId,
          contextFingerprint: outcome.contextFingerprint,
          promptVersion: outcome.promptVersion,
          schemaVersion: outcome.schemaVersion,
          safetyState: outcome.safetyState,
        });
    }
  } catch (error) {
    return handleApiError(error);
  }
}
