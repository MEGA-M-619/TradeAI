import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { diagnosticCauseRepository } from "@/lib/db/repositories/diagnosticCauseRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { updateCandidateCauseSchema } from "@/lib/validation/diagnostics";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{
    orgId: string;
    jobId: string;
    sessionId: string;
    causeId: string;
  }>;
};

/**
 * Confirming/ruling out a cause, editing its recommended next test, and
 * linking/unlinking a resolving measurement all go through this one
 * route -- diagnosticCauseRepository.update is the sole writer of
 * `status`, so the "at most one confirmed cause per session" invariant
 * and the confirmed -> diagnosed transition are enforced exactly once,
 * here (see that function's doc comment). This route never infers or
 * sets `status` itself -- it only forwards what the caller asked for.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, jobId, sessionId, causeId } = await params;
  try {
    const body = updateCandidateCauseSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The session must belong to this job (see the create-cause
        // route for the same rationale).
        const session = await diagnosticSessionRepository.getById(
          tx,
          ctx.orgId,
          jobId,
          sessionId,
        );
        if (!session) {
          return { kind: "not_found" as const, field: "session" as const };
        }

        if (body.resolvingMeasurementId) {
          // A resolving measurement must belong to this same job -- a
          // same-org measurement from a different job would otherwise
          // pass an org-only check, mirroring the measurements POST
          // route's evidence/circuit ownership checks.
          const measurement = await measurementRepository.getById(
            tx,
            ctx.orgId,
            jobId,
            body.resolvingMeasurementId,
          );
          if (!measurement) {
            return {
              kind: "not_found" as const,
              field: "measurement" as const,
            };
          }
        }

        const cause = await diagnosticCauseRepository.update(
          tx,
          ctx.orgId,
          sessionId,
          causeId,
          body,
        );
        return { kind: "ok" as const, cause };
      },
    );

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "not_found", field: result.field },
        { status: 404 },
      );
    }
    return NextResponse.json({ cause: result.cause });
  } catch (error) {
    return handleApiError(error);
  }
}
