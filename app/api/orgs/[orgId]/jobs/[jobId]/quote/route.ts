import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { quoteRepository } from "@/lib/db/repositories/quoteRepository";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

/** Returns the job's one quote, or null if none has been generated yet --
 * not a 404. A job with no quote is a normal state, not an error. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const quote = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      quoteRepository.getForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ quote });
  } catch (error) {
    return handleApiError(error);
  }
}
