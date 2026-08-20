import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { diagnosticCauseRepository } from "@/lib/db/repositories/diagnosticCauseRepository";
import { createCandidateCauseSchema } from "@/lib/validation/diagnostics";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; sessionId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId, sessionId } = await params;
  try {
    const body = createCandidateCauseSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The session must belong to this job, not just this org --
        // otherwise a same-org session id for a different job would pass
        // an org-only check. diagnosticSessionRepository.getById already
        // scopes by (orgId, jobId, sessionId), so a mismatch on either
        // returns null here.
        const session = await diagnosticSessionRepository.getById(
          tx,
          ctx.orgId,
          jobId,
          sessionId,
        );
        if (!session) {
          return { kind: "not_found" as const };
        }

        const cause = await diagnosticCauseRepository.create(
          tx,
          ctx.orgId,
          sessionId,
          ctx.userId,
          body,
        );
        return { kind: "ok" as const, cause };
      },
    );

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ cause: result.cause }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
