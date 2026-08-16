import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { deleteEvidenceObject } from "@/lib/storage/evidenceStorage";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = {
  params: Promise<{ orgId: string; jobId: string; evidenceId: string }>;
};

/**
 * Deletion is asymmetric by design (approved Phase 2 decision): the stored
 * bytes are hard-deleted, the metadata row is tombstoned.
 *
 * Order matters. The object is deleted first and the row is only
 * tombstoned once that has actually been confirmed, so a storage failure
 * leaves everything untouched and retryable rather than hiding a photo
 * from the UI while its bytes quietly remain in the bucket -- the bytes
 * are the part with the privacy cost.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const { orgId, jobId, evidenceId } = await params;
  try {
    // Read first, in its own scoped transaction: this both authorizes the
    // caller and yields the server-stored key, so the path handed to
    // Storage never originates from the request.
    const existing = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      evidenceRepository.getById(tx, ctx.orgId, jobId, evidenceId),
    );
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    await deleteEvidenceObject(existing.storageKey);

    await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      evidenceRepository.softDelete(
        tx,
        ctx.orgId,
        jobId,
        evidenceId,
        ctx.userId,
      ),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
