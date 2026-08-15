import type { TenantTxClient } from "@/lib/db/tenantContext";
import { withTenantContext } from "@/lib/db/tenantContext";
import type { OrganizationRole } from "@/lib/generated/prisma/client";

/**
 * All tenant-scoped Prisma access for `organization_memberships` must go
 * through this module -- never `prisma.organizationMembership.*` directly
 * elsewhere (see the no-restricted-syntax rule in eslint.config.mjs).
 */
export const membershipRepository = {
  /** Every org-membership row for the given user, across all their orgs. */
  async listForUser(userId: string) {
    return withTenantContext({ userId, orgId: null }, (tx) =>
      tx.organizationMembership.findMany({
        where: { userId },
        include: { organization: true },
        orderBy: { createdAt: "asc" },
      }),
    );
  },

  /** Requires a transaction already scoped to the target org. */
  async listForOrg(tx: TenantTxClient, orgId: string) {
    return tx.organizationMembership.findMany({
      where: { organizationId: orgId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
  },

  /** Requires a transaction already scoped to the target org. */
  async create(
    tx: TenantTxClient,
    orgId: string,
    userId: string,
    role: OrganizationRole,
  ) {
    return tx.organizationMembership.create({
      data: { organizationId: orgId, userId, role },
    });
  },

  /** Requires a transaction already scoped to the target org. */
  async updateRole(
    tx: TenantTxClient,
    orgId: string,
    membershipId: string,
    role: OrganizationRole,
  ) {
    return tx.organizationMembership.update({
      where: { id: membershipId, organizationId: orgId },
      data: { role },
    });
  },
};
