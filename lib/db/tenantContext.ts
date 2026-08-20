import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

export type TenantTxClient = Prisma.TransactionClient;

export type TenantContext = {
  /** Verified from the Supabase Auth session -- never client-supplied. */
  userId: string;
  /**
   * Verified via organization_memberships in lib/auth/session.ts
   * (resolveOrgContext) before this is ever set -- never client-supplied.
   * null when no specific org is selected yet (e.g. "list my
   * organizations", or the moment before a brand-new org is created).
   */
  orgId: string | null;
};

/**
 * The single chokepoint that establishes Postgres session-local
 * (SET LOCAL-equivalent) tenant context for a transaction, then runs the
 * given work inside it.
 *
 * Do not call this directly from route/service code with a client-
 * influenced orgId. The only legitimate callers are:
 *   - lib/auth/session.ts (withAuthenticatedOrgContext, resolveOrgContext),
 *     which always verifies membership first
 *   - the handful of repository functions that intentionally bootstrap
 *     with orgId: null (listing a user's own orgs, creating a new org,
 *     upserting a user's own profile)
 *
 * This is enforced by an eslint restriction (see eslint.config.mjs) in
 * addition to this comment.
 *
 * Implementation note: set_config(name, value, is_local = true) is the
 * functional equivalent of `SET LOCAL name = value`, and -- critically --
 * it is a normal parameterized function call, so Prisma's tagged-template
 * $executeRaw can bind the value safely. A hand-built `SET LOCAL x = '...'`
 * string cannot be parameterized this way and must never be used.
 * is_local = true also means the setting automatically reverts at the end
 * of this transaction, which is what makes it safe under Supavisor's
 * transaction-mode pooling: a later, unrelated transaction reusing the
 * same physical connection never inherits it.
 */
export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (tx: TenantTxClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
      if (ctx.orgId) {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
      }
      return fn(tx);
    },
    // Prisma's defaults (2s to acquire, 5s to complete) are sized for a
    // short write against a local database. Every tenant-scoped read in
    // this app runs through here, and a page that legitimately makes
    // several reads -- the job workspace loads job, evidence,
    // assessments, measurements, circuits and diagnostic sessions --
    // exceeds 5s against a pooled remote Postgres purely on round-trip
    // latency, and Prisma then refuses the commit. These raise the
    // ceiling; they do not change what the transaction does, and the
    // set_config calls remain transaction-local either way.
    //
    // Kept deliberately modest rather than generous: a long transaction
    // pins a Supavisor connection for its duration, so this is a ceiling
    // for legitimate slow round-trips, not licence to do heavy work
    // inside a transaction.
    { maxWait: 10_000, timeout: 20_000 },
  );
}
