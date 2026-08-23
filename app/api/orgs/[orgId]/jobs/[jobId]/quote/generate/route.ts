import { NextResponse } from "next/server";
import type { TenantTxClient } from "@/lib/db/tenantContext";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { materialRepository } from "@/lib/db/repositories/materialRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import {
  quoteRepository,
  type QuoteLineItemCreateInput,
} from "@/lib/db/repositories/quoteRepository";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

/**
 * Confirmed findings from the latest *completed* assessment for this job
 * -- same "latest complete, technician-verdict-filtered" pattern as
 * lib/safety/factBuilder.ts's loadAiHazardCategories, but filtered to
 * `confirmed` (a positive technician act) rather than "not rejected".
 * Only a confirmed finding is something the technician has actually
 * agreed needs addressing, which is the bar for turning it into a
 * billable line at all. Returns [] when there is no completed assessment
 * -- absence is a fact, not an error.
 */
async function loadConfirmedFindingStatements(
  tx: TenantTxClient,
  orgId: string,
  jobId: string,
): Promise<string[]> {
  const assessments = await assessmentRepository.listForJob(tx, orgId, jobId);
  const latestComplete = assessments.find((a) => a.status === "complete");
  if (!latestComplete) return [];

  const full = await assessmentRepository.getFullById(tx, orgId, jobId, latestComplete.id);
  if (!full) return [];

  return full.findings
    .filter((finding) => finding.verdict?.verdict === "confirmed")
    .map((finding) => finding.statement);
}

/**
 * Generates the job's one quote from its current state: every Material as
 * a `material` line (quantity/unit cost snapshotted as-is), and every
 * currently-confirmed finding as a zero-priced `labor` line the
 * technician fills in (a diagnostic statement has no inherent price --
 * see the doc comment on QuoteLineItem in schema.prisma). Refuses with
 * 409 if a quote already exists for this job (see QuoteAlreadyExistsError)
 * rather than overwriting one the technician may have already edited.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const result = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const job = await jobRepository.getById(tx, ctx.orgId, jobId);
      if (!job) return { kind: "not_found" as const };

      const materials = await materialRepository.listForJob(tx, ctx.orgId, jobId);
      const confirmedStatements = await loadConfirmedFindingStatements(
        tx,
        ctx.orgId,
        jobId,
      );

      const lineItems: QuoteLineItemCreateInput[] = [
        ...materials.map(
          (material): QuoteLineItemCreateInput => ({
            kind: "material",
            description: material.description,
            quantity: material.quantity,
            unitPriceCents: material.unitCostCents,
            sourceMaterialId: material.id,
          }),
        ),
        ...confirmedStatements.map(
          (statement): QuoteLineItemCreateInput => ({
            kind: "labor",
            description: statement,
            quantity: 1,
            unitPriceCents: 0,
            sourceMaterialId: null,
          }),
        ),
      ];

      const quote = await quoteRepository.create(
        tx,
        ctx.orgId,
        jobId,
        ctx.userId,
        lineItems,
      );
      return { kind: "ok" as const, quote };
    });

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ quote: result.quote }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
