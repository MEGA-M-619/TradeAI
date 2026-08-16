import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { confirmEvidenceSchema } from "@/lib/validation/evidence";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; evidenceId: string }>;
};

/**
 * Step 2 of the two-phase upload: the bytes are up, so promote the row
 * from `pending` to `ready` and record the metadata the client observed.
 *
 * The metadata is client-asserted -- with direct-to-storage upload the
 * server never sees the bytes. It is bounded by the validation schema and
 * stored as a claim (`clientSha256`), never treated as verified. What
 * actually constrains the upload is the bucket's own MIME and size
 * limits, which Storage enforces regardless of what is claimed here.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId, evidenceId } = await params;
  try {
    const body = confirmEvidenceSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const existing = await evidenceRepository.getById(
        tx,
        ctx.orgId,
        jobId,
        evidenceId,
      );
      if (!existing) return null;

      return evidenceRepository.markReady(tx, ctx.orgId, jobId, evidenceId, {
        byteSize: body.byteSize,
        width: body.width ?? null,
        height: body.height ?? null,
        clientSha256: body.clientSha256 ?? null,
        capturedAt: body.capturedAt ?? null,
      });
    });

    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ evidence: result });
  } catch (error) {
    return handleApiError(error);
  }
}
