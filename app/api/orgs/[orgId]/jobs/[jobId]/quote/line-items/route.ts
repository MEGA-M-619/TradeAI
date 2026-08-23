import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { quoteRepository } from "@/lib/db/repositories/quoteRepository";
import { createLaborLineItemSchema } from "@/lib/validation/quote";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

/** Always adds a `labor` line -- the only kind addable directly (see
 * quoteRepository.addLaborLine). A `material` line only ever comes from
 * .../quote/generate. */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createLaborLineItemSchema.parse(await request.json());

    const quote = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      quoteRepository.addLaborLine(tx, ctx.orgId, jobId, body),
    );

    if (!quote) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ quote }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
