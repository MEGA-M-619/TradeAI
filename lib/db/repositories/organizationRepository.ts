import { randomUUID } from "node:crypto";
import type { TenantTxClient } from "@/lib/db/tenantContext";
import { withTenantContext } from "@/lib/db/tenantContext";

/**
 * All tenant-scoped Prisma access for `organizations` must go through
 * this module -- never `prisma.organization.*` directly elsewhere (see
 * the no-restricted-syntax rule in eslint.config.mjs).
 *
 * `listForUser` and `create` are the two intentional exceptions to "every
 * operation needs an already-verified org context": listing your own
 * orgs and creating a brand-new one both have to work before any single
 * org has been selected.
 */
export const organizationRepository = {
  /** List every organization the given user is a member of. */
  async listForUser(userId: string) {
    return withTenantContext({ userId, orgId: null }, (tx) =>
      tx.organization.findMany({
        where: { memberships: { some: { userId } } },
        orderBy: { createdAt: "asc" },
      }),
    );
  },

  /**
   * Create a new organization and make the creating user its owner.
   * Sets app.current_org_id partway through the transaction, once the
   * new org exists, so the membership insert goes through the standard
   * org-scoped RLS policy rather than needing a special case of its own.
   *
   * Deliberately does NOT use `tx.organization.create(...)` for the
   * initial insert. Postgres requires a row returned via `RETURNING`
   * (which Prisma's `.create()` always generates) to also satisfy an
   * applicable SELECT policy, not merely the INSERT policy's WITH CHECK.
   * organizations' SELECT policy is `is_member_of(id)`, which cannot be
   * true yet for a brand-new org -- the founding membership row doesn't
   * exist until the next statement. Generating the id client-side and
   * inserting via a plain (non-RETURNING) raw statement sidesteps that;
   * the org becomes visible via a normal SELECT once the membership
   * exists and org context is set, a few lines down. See
   * docs/architecture/security.md and the regression test in
   * tests/security/regression.test.ts.
   */
  async create(userId: string, name: string) {
    return withTenantContext({ userId, orgId: null }, async (tx) => {
      const newOrgId = randomUUID();

      await tx.$executeRaw`INSERT INTO organizations (id, name, updated_at) VALUES (${newOrgId}::uuid, ${name}, now())`;

      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${newOrgId}, true)`;

      // organization_memberships' SELECT policy (select_own_memberships)
      // grants visibility into your own membership rows unconditionally,
      // so this insert's implicit RETURNING has no equivalent
      // bootstrapping problem.
      await tx.organizationMembership.create({
        data: { organizationId: newOrgId, userId, role: "owner" },
      });

      return tx.organization.findUniqueOrThrow({ where: { id: newOrgId } });
    });
  },

  /** Requires a transaction already scoped to the target org. */
  async getCurrent(tx: TenantTxClient, orgId: string) {
    return tx.organization.findUnique({ where: { id: orgId } });
  },

  /** Requires a transaction already scoped to the target org. */
  async update(tx: TenantTxClient, orgId: string, data: { name?: string }) {
    return tx.organization.update({ where: { id: orgId }, data });
  },
};
