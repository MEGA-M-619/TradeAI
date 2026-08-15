import { createSupabaseServerClient } from "@/lib/auth/supabaseServerClient";
import { withTenantContext, type TenantTxClient } from "@/lib/db/tenantContext";
import { userRepository } from "@/lib/db/repositories/userRepository";

export class UnauthenticatedError extends Error {
  constructor(message = "No authenticated session") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenOrgAccessError extends Error {
  constructor(message = "User is not a member of the requested organization") {
    super(message);
    this.name = "ForbiddenOrgAccessError";
  }
}

/**
 * Step 1-2 of the tenant-context flow: verify the session/JWT server-side
 * and extract the verified user id. This is the ONLY fact trusted from
 * the client in this whole chain -- everything else (org id, role) is
 * re-derived from the database, never taken from a client claim.
 */
export async function getAuthenticatedUserId(): Promise<string> {
  const { id } = await getAuthenticatedUser();
  return id;
}

/** Same verification as getAuthenticatedUserId, also returning email --
 * needed only by ensureCurrentUserProfile below. */
export async function getAuthenticatedUser(): Promise<{
  id: string;
  email: string;
}> {
  const supabase = await createSupabaseServerClient();
  // getUser() (not getSession()) contacts Supabase Auth to validate the
  // token server-side rather than trusting an unverified cookie payload.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new UnauthenticatedError();
  }
  return { id: data.user.id, email: data.user.email ?? "" };
}

/**
 * Verifies the session and idempotently upserts the app-side users
 * profile row (see lib/db/repositories/userRepository.ts). There is no
 * signup webhook in this app, so this is the actual provisioning point --
 * call it from pages/flows that are about to do something requiring the
 * profile row to already exist (creating or joining an organization).
 * Ordinary reads (e.g. an API route just fetching customers) don't need
 * this -- getAuthenticatedUserId is enough and avoids an unnecessary
 * write on every request.
 */
export async function ensureCurrentUserProfile(): Promise<string> {
  const { id, email } = await getAuthenticatedUser();
  await userRepository.ensureProfile(id, email);
  return id;
}

/**
 * Step 3-5: the client-supplied org id is only ever a lookup key. It only
 * becomes trusted once we've confirmed, via a fresh database read, that
 * the verified user actually has a membership row for it. This query
 * itself runs through withTenantContext with orgId: null, so it is
 * governed by the users-can-only-see-their-own-membership-rows RLS
 * policy -- i.e. even this check cannot be tricked into confirming
 * someone else's membership.
 */
export async function resolveOrgContext(
  userId: string,
  requestedOrgId: string,
): Promise<string> {
  const membership = await withTenantContext({ userId, orgId: null }, (tx) =>
    tx.organizationMembership.findFirst({
      where: { userId, organizationId: requestedOrgId },
      select: { id: true },
    }),
  );
  if (!membership) {
    throw new ForbiddenOrgAccessError();
  }
  return requestedOrgId;
}

/**
 * The single chokepoint route handlers should use for any tenant-scoped
 * operation: verify session -> verify membership -> only then open a
 * transaction with that org's context set. See
 * docs/architecture/security.md for the full request-flow diagram.
 */
export async function withAuthenticatedOrgContext<T>(
  requestedOrgId: string,
  fn: (
    tx: TenantTxClient,
    ctx: { userId: string; orgId: string },
  ) => Promise<T>,
): Promise<T> {
  const userId = await getAuthenticatedUserId();
  const orgId = await resolveOrgContext(userId, requestedOrgId);
  return withTenantContext({ userId, orgId }, (tx) =>
    fn(tx, { userId, orgId }),
  );
}
