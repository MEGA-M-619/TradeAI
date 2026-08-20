import type { TenantTxClient } from "@/lib/db/tenantContext";
import type {
  MeasurementResult,
  MeasurementTestType,
} from "@/lib/generated/prisma/client";

export type MeasurementInput = {
  circuitId?: string | null;
  evidenceId?: string | null;
  testType: MeasurementTestType;
  value: number;
  unit: string;
  expectedMin?: number | null;
  expectedMax?: number | null;
  /** Left unset (null) until the deterministic rule engine evaluates it --
   * see the doc comment on Measurement.result in schema.prisma. */
  result?: MeasurementResult | null;
  note?: string | null;
  recordedAt?: Date;
};

/**
 * All tenant-scoped Prisma access for `measurements` must go through this
 * module -- never `prisma.measurement.*` directly elsewhere (see the
 * no-restricted-syntax rule in eslint.config.mjs). Every function requires
 * an already org-scoped transaction client (from
 * withAuthenticatedOrgContext).
 */
export const measurementRepository = {
  async listForJob(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.measurement.findMany({
      where: { organizationId: orgId, jobId },
      orderBy: { recordedAt: "asc" },
    });
  },

  /** Job memory's per-circuit read: every measurement ever recorded
   * against this circuit, across every job. */
  async listForCircuit(tx: TenantTxClient, orgId: string, circuitId: string) {
    return tx.measurement.findMany({
      where: { organizationId: orgId, circuitId },
      orderBy: { recordedAt: "asc" },
    });
  },

  async getById(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    measurementId: string,
  ) {
    return tx.measurement.findFirst({
      where: { id: measurementId, organizationId: orgId, jobId },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    recordedByUserId: string,
    data: MeasurementInput,
  ) {
    return tx.measurement.create({
      data: { organizationId: orgId, jobId, recordedByUserId, ...data },
    });
  },
};
