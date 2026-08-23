import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { materialRepository } from "@/lib/db/repositories/materialRepository";
import { updateMaterialSchema } from "@/lib/validation/material";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; materialId: string }>;
};

// PATCH/DELETE rely on handleApiError's P2025 -> 404 mapping rather than a
// pre-read, matching app/api/.../circuits/[circuitId]/route.ts: the
// where clause (id + organizationId + jobId) is the only thing that can
// make the row inaddressable, so a separate existence check would just
// duplicate that same condition.

export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, jobId, materialId } = await params;
  try {
    const body = updateMaterialSchema.parse(await request.json());
    const material = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      materialRepository.update(tx, ctx.orgId, jobId, materialId, body),
    );
    return NextResponse.json({ material });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { orgId, jobId, materialId } = await params;
  try {
    await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      materialRepository.remove(tx, ctx.orgId, jobId, materialId),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
