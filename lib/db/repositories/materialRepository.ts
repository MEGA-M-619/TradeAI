import type { TenantTxClient } from "@/lib/db/tenantContext";

export type MaterialInput = {
  description: string;
  quantity: number;
  unitCostCents: number;
};

/**
 * All tenant-scoped Prisma access for `materials` must go through this
 * module -- never `prisma.material.*` directly elsewhere (see the
 * no-restricted-syntax rule in eslint.config.mjs). Every function
 * requires an already org-scoped transaction client (from
 * withAuthenticatedOrgContext).
 *
 * `source` is never accepted as input here -- every row created through
 * this repository is manual entry, so the schema default is the only
 * value that can ever be written until a later phase adds a producer for
 * any other MaterialSource variant.
 */
export const materialRepository = {
  async listForJob(tx: TenantTxClient, orgId: string, jobId: string) {
    return tx.material.findMany({
      where: { organizationId: orgId, jobId },
      orderBy: { createdAt: "asc" },
    });
  },

  async getById(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    materialId: string,
  ) {
    return tx.material.findFirst({
      where: { id: materialId, organizationId: orgId, jobId },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    createdByUserId: string,
    data: MaterialInput,
  ) {
    return tx.material.create({
      data: { organizationId: orgId, jobId, createdByUserId, ...data },
    });
  },

  async update(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    materialId: string,
    data: Partial<MaterialInput>,
  ) {
    return tx.material.update({
      where: { id: materialId, organizationId: orgId, jobId },
      data,
    });
  },

  async remove(
    tx: TenantTxClient,
    orgId: string,
    jobId: string,
    materialId: string,
  ) {
    return tx.material.delete({
      where: { id: materialId, organizationId: orgId, jobId },
    });
  },
};
