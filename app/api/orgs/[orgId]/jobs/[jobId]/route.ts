import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { updateJobSchema } from "@/lib/validation/job";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const job = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      jobRepository.getById(tx, ctx.orgId, jobId),
    );
    if (!job) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = updateJobSchema.parse(await request.json());
    const job = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      jobRepository.update(tx, ctx.orgId, jobId, body),
    );
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
