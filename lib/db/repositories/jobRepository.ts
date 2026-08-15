import type { TenantTxClient } from "@/lib/db/tenantContext";
import type { JobStatus } from "@/lib/generated/prisma/client";

export type JobInput = {
  customerId: string;
  title: string;
  problemDescription?: string | null;
};

/**
 * All tenant-scoped Prisma access for `jobs` must go through this module
 * -- never `prisma.job.*` directly elsewhere (see the no-restricted-
 * syntax rule in eslint.config.mjs). Every function requires an already
 * org-scoped transaction client (from withAuthenticatedOrgContext).
 */
export const jobRepository = {
  async listForOrg(tx: TenantTxClient, orgId: string) {
    return tx.job.findMany({
      where: { organizationId: orgId },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async listForCustomer(tx: TenantTxClient, orgId: string, customerId: string) {
    return tx.job.findMany({
      where: { organizationId: orgId, customerId },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.job.findFirst({
      where: { id: jobId, organizationId: orgId },
      include: { customer: true },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    createdByUserId: string,
    data: JobInput,
  ) {
    return tx.job.create({
      data: { organizationId: orgId, createdByUserId, ...data },
    });
  },

  async update(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    data: Partial<Pick<JobInput, "title" | "problemDescription">> & {
      status?: JobStatus;
    },
  ) {
    return tx.job.update({
      where: { id: jobId, organizationId: orgId },
      data,
    });
  },
};
