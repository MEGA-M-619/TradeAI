import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { updateCustomerSchema } from "@/lib/validation/customer";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; customerId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, customerId } = await params;
  try {
    const customer = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      customerRepository.getById(tx, ctx.orgId, customerId),
    );
    if (!customer) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ customer });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, customerId } = await params;
  try {
    const body = updateCustomerSchema.parse(await request.json());
    const customer = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      customerRepository.update(tx, ctx.orgId, customerId, body),
    );
    return NextResponse.json({ customer });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { orgId, customerId } = await params;
  try {
    await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      customerRepository.delete(tx, ctx.orgId, customerId),
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}
