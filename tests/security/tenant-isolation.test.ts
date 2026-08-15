import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
} from "./helpers";
import { prisma } from "@/lib/db/prisma";
import { withTenantContext } from "@/lib/db/tenantContext";
import { resolveOrgContext, ForbiddenOrgAccessError } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";

// Tests 1-7 from the Phase 0 spec. Requires a live Supabase project --
// see tests/security/helpers.ts and .env.example. Skipped by default.
describe.skipIf(!dbTestsEnabled)("tenant isolation", () => {
  // Constructed in beforeAll, not here: describe.skipIf still evaluates
  // this describe body (only the `it`s are skipped), so anything that
  // reads env vars eagerly must not run at this scope, or the skip would
  // still throw before it takes effect.
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  let privileged: ReturnType<typeof createPrivilegedPool>;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let orgA: { id: string };
  let orgB: { id: string };

  beforeAll(async () => {
    admin = createAdminSupabaseClient();
    privileged = createPrivilegedPool();

    const emailA = `tradeai-tenant-test-a-${randomUUID()}@example.invalid`;
    const emailB = `tradeai-tenant-test-b-${randomUUID()}@example.invalid`;

    const { data: createdA, error: errA } = await admin.auth.admin.createUser({
      email: emailA,
      email_confirm: true,
    });
    if (errA || !createdA.user) {
      throw errA ?? new Error("failed to create test user A");
    }
    const { data: createdB, error: errB } = await admin.auth.admin.createUser({
      email: emailB,
      email_confirm: true,
    });
    if (errB || !createdB.user) {
      throw errB ?? new Error("failed to create test user B");
    }

    userA = { id: createdA.user.id, email: emailA };
    userB = { id: createdB.user.id, email: emailB };

    await userRepository.ensureProfile(userA.id, userA.email);
    await userRepository.ensureProfile(userB.id, userB.email);

    orgA = await organizationRepository.create(userA.id, "Tenant Test Org A");
    orgB = await organizationRepository.create(userB.id, "Tenant Test Org B");
  });

  afterAll(async () => {
    // Guarded throughout: if beforeAll failed partway, some of these may
    // be undefined/unset, and a cleanup failure should not mask the
    // original setup error with a second, confusing one.
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    if (privileged && orgIds.length > 0) {
      await privileged.query(
        `delete from public.organization_memberships where organization_id = any($1::uuid[])`,
        [orgIds],
      );
      await privileged.query(
        `delete from public.organizations where id = any($1::uuid[])`,
        [orgIds],
      );
    }
    if (admin && userA) await admin.auth.admin.deleteUser(userA.id);
    if (admin && userB) await admin.auth.admin.deleteUser(userB.id);
    await privileged?.end();
    await prisma.$disconnect();
  });

  it("Test 1: same-organization access succeeds", async () => {
    const orgId = await resolveOrgContext(userA.id, orgA.id);
    const org = await withTenantContext({ userId: userA.id, orgId }, (tx) =>
      organizationRepository.getCurrent(tx, orgId),
    );
    expect(org?.id).toBe(orgA.id);
  });

  it("Test 2: cross-organization access is denied", async () => {
    await expect(resolveOrgContext(userA.id, orgB.id)).rejects.toThrow(
      ForbiddenOrgAccessError,
    );
  });

  it("Test 3: a forged org id is rejected even though that org genuinely exists", async () => {
    // userA is authenticated, but the request names orgB's real id.
    await expect(resolveOrgContext(userA.id, orgB.id)).rejects.toThrow(
      ForbiddenOrgAccessError,
    );
  });

  it("Test 4: an unknown/nonexistent org id is rejected", async () => {
    await expect(resolveOrgContext(userA.id, randomUUID())).rejects.toThrow(
      ForbiddenOrgAccessError,
    );
  });

  it("Test 5: missing tenant context blocks a context-gated write, without throwing", async () => {
    // Deliberately targets an UPDATE, not a SELECT. organizations' SELECT
    // policy (select_member_orgs) is intentionally membership-gated, not
    // context-gated -- it has to work with no org selected yet, because
    // that's exactly what "list my organizations" is. A user reading a
    // row they are a genuine member of, with no context set, is expected
    // behavior, not a leak (see docs/architecture/security.md).
    //
    // Mutations are different: update_own_org requires
    // id = current_setting('app.current_org_id')::uuid, which is exactly
    // "missing context" when never set. That's the operation this test
    // exercises. Before the NULLIF fix (see migration
    // 20260815000003_fix_rls_empty_guc), this would throw "invalid input
    // syntax for type uuid" on a connection that had previously touched
    // app.current_org_id, instead of the affectedCount:0 asserted below.
    const affected = await withTenantContext(
      { userId: userA.id, orgId: null }, // app.current_org_id deliberately never set
      (tx) =>
        tx.organization.updateMany({
          where: { id: orgA.id },
          data: { name: "should not be applied" },
        }),
    );
    expect(affected.count).toBe(0);

    const stillOriginal = await withTenantContext(
      { userId: userA.id, orgId: orgA.id },
      (tx) => organizationRepository.getCurrent(tx, orgA.id),
    );
    expect(stillOriginal?.name).toBe("Tenant Test Org A");
  });

  it("Test 6: a forged tenant context does not expose the other org's data", async () => {
    // Simulates an app-layer bug that set app.current_org_id to orgB for
    // a request actually authenticated as userA, without ever calling
    // resolveOrgContext. RLS's is_member_of() re-derivation (see the
    // tenant_rls migration) must independently block this -- proving RLS
    // is real defense-in-depth rather than trusting whatever context the
    // app declares.
    const rows = await withTenantContext(
      { userId: userA.id, orgId: orgB.id },
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`select id from organizations where id = ${orgB.id}::uuid`,
    );
    expect(rows).toEqual([]);
  });

  it("Test 7: concurrent tenant transactions do not leak context across a pooled connection", async () => {
    const iterations = 20;
    const results = await Promise.all(
      Array.from({ length: iterations }, (_, i) => {
        const acting = i % 2 === 0 ? userA : userB;
        const org = i % 2 === 0 ? orgA : orgB;
        const other = i % 2 === 0 ? orgB : orgA;
        return withTenantContext(
          { userId: acting.id, orgId: org.id },
          (tx) => tx.$queryRaw<{ id: string }[]>`select id from organizations`,
        ).then((rows) => ({ mine: org.id, other: other.id, rows }));
      }),
    );

    for (const { mine, other, rows } of results) {
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(other);
    }
  });
});
