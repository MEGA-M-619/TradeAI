import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { createJobSchema } from "@/lib/validation/job";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  try {
    const jobs = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      jobRepository.listForOrg(tx, ctx.orgId),
    );
    return NextResponse.json({ jobs });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  try {
    const body = createJobSchema.parse(await request.json());
    const job = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      jobRepository.create(tx, ctx.orgId, ctx.userId, body),
    );
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
