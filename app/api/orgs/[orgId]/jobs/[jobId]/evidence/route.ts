import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import {
  createEvidenceSchema,
  MAX_EVIDENCE_PER_JOB,
} from "@/lib/validation/evidence";
import {
  buildEvidenceKey,
  createEvidenceUploadUrl,
} from "@/lib/storage/evidenceStorage";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const evidence = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      evidenceRepository.listForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ evidence });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Step 1 of the two-phase upload: reserve a `pending` row and hand back a
 * one-shot signed upload URL for its server-derived storage key. The
 * client never chooses the bucket or the path.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createEvidenceSchema.parse(await request.json());

    const prepared = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The job must belong to this org. Without this an attacker could
        // pair their own org id with someone else's job id; RLS would
        // still confine the row, but the evidence would be filed against
        // a job that isn't theirs to write to.
        const job = await jobRepository.getById(tx, ctx.orgId, jobId);
        if (!job) return { kind: "not_found" as const };

        const count = await evidenceRepository.countForJob(
          tx,
          ctx.orgId,
          jobId,
        );
        if (count >= MAX_EVIDENCE_PER_JOB) {
          return { kind: "too_many" as const };
        }

        const evidenceId = randomUUID();
        const storageKey = buildEvidenceKey(ctx.orgId, jobId, evidenceId);
        const row = await evidenceRepository.create(tx, ctx.orgId, {
          id: evidenceId,
          jobId,
          uploadedByUserId: ctx.userId,
          storageKey,
          mimeType: body.mimeType,
          caption: body.caption,
        });
        return { kind: "ok" as const, row };
      },
    );

    if (prepared.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (prepared.kind === "too_many") {
      return NextResponse.json(
        { error: "too_many_evidence", limit: MAX_EVIDENCE_PER_JOB },
        { status: 409 },
      );
    }

    // Minted outside the transaction: it's a network call to Storage, and
    // holding a Postgres transaction open across it would pin a pooled
    // connection for the duration.
    const upload = await createEvidenceUploadUrl(prepared.row.storageKey);

    return NextResponse.json(
      {
        evidence: prepared.row,
        upload: { signedUrl: upload.signedUrl, token: upload.token },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
