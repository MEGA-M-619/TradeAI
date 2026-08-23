import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { quoteRepository } from "@/lib/db/repositories/quoteRepository";
import { updateQuoteLineItemSchema } from "@/lib/validation/quote";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; lineItemId: string }>;
};

/** Applies to a line item of either kind -- see the doc comment on
 * quoteRepository.updateLineItem. Both routes return the whole updated
 * quote (recomputed totals included), not just the touched line item, so
 * the UI never has to reconcile a partial response against its own
 * running total. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, jobId, lineItemId } = await params;
  try {
    const body = updateQuoteLineItemSchema.parse(await request.json());
    const quote = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      quoteRepository.updateLineItem(tx, ctx.orgId, jobId, lineItemId, body),
    );
    if (!quote) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ quote });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { orgId, jobId, lineItemId } = await params;
  try {
    const quote = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      quoteRepository.removeLineItem(tx, ctx.orgId, jobId, lineItemId),
    );
    if (!quote) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ quote });
  } catch (error) {
    return handleApiError(error);
  }
}
