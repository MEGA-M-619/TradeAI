import type { TenantTxClient } from "@/lib/db/tenantContext";

export type CircuitInput = {
  label: string;
  panelLabel?: string | null;
  breakerRating?: number | null;
  description?: string | null;
};

/**
 * All tenant-scoped Prisma access for `circuits` must go through this
 * module -- never `prisma.circuit.*` directly elsewhere (see the
 * no-restricted-syntax rule in eslint.config.mjs). Every function
 * requires an already org-scoped transaction client (from
 * withAuthenticatedOrgContext).
 */
export const circuitRepository = {
  async listForCustomer(tx: TenantTxClient, orgId: string, customerId: string) {
    return tx.circuit.findMany({
      where: { organizationId: orgId, customerId },
      orderBy: { createdAt: "asc" },
    });
  },

  async getById(
    tx: TenantTxClient,
    orgId: string,
    customerId: string,
    circuitId: string,
  ) {
    return tx.circuit.findFirst({
      where: { id: circuitId, organizationId: orgId, customerId },
    });
  },

  /**
   * Batch lookup, mirroring evidenceRepository.listByIdsForJob: callers
   * must check the returned count against the requested id count rather
   * than assume a 1:1 match -- ids for a different customer or org are
   * simply absent from the result, not an error.
   */
  async listByIdsForCustomer(
    tx: TenantTxClient,
    orgId: string,
    customerId: string,
    circuitIds: string[],
  ) {
    return tx.circuit.findMany({
      where: { id: { in: circuitIds }, organizationId: orgId, customerId },
    });
  },

  async create(
    tx: TenantTxClient,
    orgId: string,
    customerId: string,
    data: CircuitInput,
  ) {
    return tx.circuit.create({
      data: { organizationId: orgId, customerId, ...data },
    });
  },

  async update(
    tx: TenantTxClient,
    orgId: string,
    customerId: string,
    circuitId: string,
    data: Partial<CircuitInput>,
  ) {
    return tx.circuit.update({
      where: { id: circuitId, organizationId: orgId, customerId },
      data,
    });
  },
};
