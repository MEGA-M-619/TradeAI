import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { createDiagnosticSessionSchema } from "@/lib/validation/diagnostics";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const sessions = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      diagnosticSessionRepository.listForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ sessions });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createDiagnosticSessionSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The job must belong to this org, matching the evidence/
        // measurements POST routes' rationale: without this an attacker
        // could pair their own org id with someone else's job id.
        const job = await jobRepository.getById(tx, ctx.orgId, jobId);
        if (!job) {
          return { kind: "not_found" as const };
        }

        const session = await diagnosticSessionRepository.create(
          tx,
          ctx.orgId,
          jobId,
          ctx.userId,
          body,
        );
        return { kind: "ok" as const, session };
      },
    );

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ session: result.session }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
