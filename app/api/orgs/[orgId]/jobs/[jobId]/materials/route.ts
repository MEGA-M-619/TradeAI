import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { materialRepository } from "@/lib/db/repositories/materialRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { createMaterialSchema } from "@/lib/validation/material";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const materials = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      materialRepository.listForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ materials });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createMaterialSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      // The job must belong to this org, matching the measurement/evidence
      // POST routes' rationale: without this an attacker could pair their
      // own org id with someone else's job id.
      const job = await jobRepository.getById(tx, ctx.orgId, jobId);
      if (!job) return { kind: "not_found" as const };

      const material = await materialRepository.create(
        tx,
        ctx.orgId,
        jobId,
        ctx.userId,
        body,
      );
      return { kind: "ok" as const, material };
    });

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ material: result.material }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
