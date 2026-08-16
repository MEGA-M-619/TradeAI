import type { TenantTxClient } from "@/lib/db/tenantContext";

export type CustomerInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
};

/**
 * All tenant-scoped Prisma access for `customers` must go through this
 * module -- never `prisma.customer.*` directly elsewhere (see the
 * no-restricted-syntax rule in eslint.config.mjs). Every function
 * requires an already org-scoped transaction client (from
 * withAuthenticatedOrgContext) -- unlike organizations, customers have no
 * bootstrapping case, so there is no exception here.
 */
export const customerRepository = {
  /**
   * Includes a job count per customer (`_count.jobs`) -- a plain
   * aggregate on the existing relation, not a schema change -- so the
   * customers list can show "3 jobs" without a second query per row.
   */
  async listForOrg(tx: TenantTxClient, orgId: string) {
    return tx.customer.findMany({
      where: { organizationId: orgId },
      include: { _count: { select: { jobs: true } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async getById(tx: TenantTxClient, orgId: string, customerId: string) {
    return tx.customer.findFirst({
      where: { id: customerId, organizationId: orgId },
    });
  },

  async create(tx: TenantTxClient, orgId: string, data: CustomerInput) {
    return tx.customer.create({
      data: { organizationId: orgId, ...data },
    });
  },

  async update(
    tx: TenantTxClient,
    orgId: string,
    customerId: string,
    data: Partial<CustomerInput>,
  ) {
    return tx.customer.update({
      where: { id: customerId, organizationId: orgId },
      data,
    });
  },

  async delete(tx: TenantTxClient, orgId: string, customerId: string) {
    return tx.customer.delete({
      where: { id: customerId, organizationId: orgId },
    });
  },
};
