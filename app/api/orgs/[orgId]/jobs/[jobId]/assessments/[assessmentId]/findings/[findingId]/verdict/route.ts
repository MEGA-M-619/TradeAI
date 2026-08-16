import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { verdictRepository } from "@/lib/db/repositories/verdictRepository";
import { verdictSchema } from "@/lib/validation/assessment";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; assessmentId: string; findingId: string }>;
};

/**
 * The human act: confirming, rejecting, amending, or leaving unresolved
 * one finding. This never touches the finding itself -- what the model
 * said is immutable -- it only ever writes to technician_verdict, a
 * separate table (see prisma/schema.prisma's doc comment on
 * TechnicianVerdict for why that separation matters).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId, assessmentId, findingId } = await params;
  try {
    const body = verdictSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const assessment = await assessmentRepository.getById(tx, ctx.orgId, jobId, assessmentId);
      if (!assessment) return null;
      // Scoped by assessmentId too, so a valid finding id from a
      // different assessment in this org can't be verdicted here.
      const finding = await assessmentRepository.getFindingById(
        tx,
        ctx.orgId,
        assessmentId,
        findingId,
      );
      if (!finding) return null;

      return verdictRepository.upsert(tx, ctx.orgId, assessmentId, findingId, ctx.userId, body);
    });

    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ verdict: result });
  } catch (error) {
    return handleApiError(error);
  }
}
