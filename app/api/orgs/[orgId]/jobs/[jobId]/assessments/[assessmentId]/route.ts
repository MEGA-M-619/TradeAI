import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; assessmentId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId, assessmentId } = await params;
  try {
    // Opportunistic reap: cheap (one indexed UPDATE across all orgs,
    // typically zero rows), global, and safe to call on every poll -- see
    // lib/db/repositories/assessmentRepository.ts's reapStuck(). This
    // means a stuck `running` assessment resolves to `failed` for
    // whoever happens to be polling it, without depending on an external
    // cron ever being configured.
    await assessmentRepository.reapStuck().catch((err) => {
      console.error("opportunistic reap failed", err);
    });

    const assessment = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      assessmentRepository.getFullById(tx, ctx.orgId, jobId, assessmentId),
    );
    if (!assessment) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ assessment });
  } catch (error) {
    return handleApiError(error);
  }
}
