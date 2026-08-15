import { withTenantContext } from "@/lib/db/tenantContext";

/**
 * All tenant-scoped Prisma access for `users` must go through this module
 * -- never `prisma.user.*` directly elsewhere (see the no-restricted-
 * syntax rule in eslint.config.mjs).
 */
export const userRepository = {
  /**
   * Idempotently creates or refreshes the app-side profile row for a
   * Supabase Auth user. There is no signup webhook/trigger in Phase 0 --
   * this is called from the request path right after a session is
   * verified, so the very first authenticated request for a new user
   * creates their profile row. Only ever touches the caller's own row
   * (self_write / self_update RLS policies).
   */
  async ensureProfile(userId: string, email: string) {
    return withTenantContext({ userId, orgId: null }, (tx) =>
      tx.user.upsert({
        where: { id: userId },
        create: { id: userId, email },
        update: { email },
      }),
    );
  },

  async getSelf(userId: string) {
    return withTenantContext({ userId, orgId: null }, (tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
  },
};
