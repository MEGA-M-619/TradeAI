import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { updateCircuitSchema } from "@/lib/validation/circuit";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; customerId: string; circuitId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, customerId, circuitId } = await params;
  try {
    const circuit = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      circuitRepository.getById(tx, ctx.orgId, customerId, circuitId),
    );
    if (!circuit) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ circuit });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, customerId, circuitId } = await params;
  try {
    const body = updateCircuitSchema.parse(await request.json());
    const circuit = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      circuitRepository.update(tx, ctx.orgId, customerId, circuitId, body),
    );
    return NextResponse.json({ circuit });
  } catch (error) {
    return handleApiError(error);
  }
}
