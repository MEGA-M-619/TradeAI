import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { createCustomerSchema } from "@/lib/validation/customer";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  try {
    const customers = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      customerRepository.listForOrg(tx, ctx.orgId),
    );
    return NextResponse.json({ customers });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params;
  try {
    const body = createCustomerSchema.parse(await request.json());
    const customer = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      customerRepository.create(tx, ctx.orgId, body),
    );
    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
