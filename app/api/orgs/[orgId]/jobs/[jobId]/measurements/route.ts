import { NextResponse } from "next/server";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { createMeasurementSchema } from "@/lib/validation/measurement";
import { evaluateMeasurementResult } from "@/lib/diagnostics/measurementRules";
import { handleApiError } from "@/lib/http/handleApiError";

type RouteContext = { params: Promise<{ orgId: string; jobId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const measurements = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
      measurementRepository.listForJob(tx, ctx.orgId, jobId),
    );
    return NextResponse.json({ measurements });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, jobId } = await params;
  try {
    const body = createMeasurementSchema.parse(await request.json());

    const result = await withAuthenticatedOrgContext(
      orgId,
      async (tx, ctx) => {
        // The job must belong to this org, matching the evidence POST
        // route's rationale: without this an attacker could pair their
        // own org id with someone else's job id.
        const job = await jobRepository.getById(tx, ctx.orgId, jobId);
        if (!job) {
          return { kind: "not_found" as const, field: "job" as const };
        }

        if (body.circuitId) {
          // A circuit is scoped to the customer, not the job -- verify the
          // selected circuit actually belongs to *this job's* customer,
          // not just to the same org. A same-org, different-customer
          // circuit id would otherwise pass an org-only check.
          const circuit = await circuitRepository.getById(
            tx,
            ctx.orgId,
            job.customerId,
            body.circuitId,
          );
          if (!circuit) {
            return { kind: "not_found" as const, field: "circuit" as const };
          }
        }

        if (body.evidenceId) {
          const evidence = await evidenceRepository.getById(
            tx,
            ctx.orgId,
            jobId,
            body.evidenceId,
          );
          if (!evidence) {
            return { kind: "not_found" as const, field: "evidence" as const };
          }
        }

        // Computed synchronously, from the same expectedMin/expectedMax
        // the technician just supplied, before the row is ever persisted
        // -- see lib/diagnostics/measurementRules.ts. Resolves the "how
        // does result get set" question left open after Phase 1/2.
        const result = evaluateMeasurementResult({
          value: body.value,
          expectedMin: body.expectedMin,
          expectedMax: body.expectedMax,
        });

        const measurement = await measurementRepository.create(
          tx,
          ctx.orgId,
          jobId,
          ctx.userId,
          { ...body, result },
        );
        return { kind: "ok" as const, measurement };
      },
    );

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "not_found", field: result.field },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { measurement: result.measurement },
      { status: 201 },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
