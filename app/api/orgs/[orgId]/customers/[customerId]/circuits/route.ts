import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { createCircuitSchema } from "@/lib/validation/circuit";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; customerId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, customerId } = await params;
  try {
    const circuits = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      circuitRepository.listForCustomer(tx, ctx.orgId, customerId),
    );
    return NextResponse.json({ circuits });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, customerId } = await params;
  try {
    const body = createCircuitSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The customer must belong to this org -- without this an attacker
        // could pair their own org id with someone else's customer id; RLS
        // would still confine the row, but the circuit would be filed
        // against a customer that isn't theirs.
        const customer = await customerRepository.getById(
          tx,
          ctx.orgId,
          customerId,
        );
        if (!customer) return { kind: "not_found" as const };

        const circuit = await circuitRepository.create(
          tx,
          ctx.orgId,
          customerId,
          body,
        );
        return { kind: "ok" as const, circuit };
      },
    );

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ circuit: result.circuit }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
