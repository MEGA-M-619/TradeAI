import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  dbTestsEnabled,
  createAdminSupabaseClient,
  createPrivilegedPool,
  requireEnv,
} from "./helpers";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { membershipRepository } from "@/lib/db/repositories/membershipRepository";
import { userRepository } from "@/lib/db/repositories/userRepository";
import { withTenantContext } from "@/lib/db/tenantContext";
import { prisma } from "@/lib/db/prisma";

// Regression coverage for the two bugs found while first running the
// security suite against a real Supabase database. Requires a live
// Supabase project. Skipped by default. Self-contained -- does not depend
// on fixtures from other test files or on Vitest's file execution order.
describe.skipIf(!dbTestsEnabled)("Phase 0 regressions", () => {
  let privileged: ReturnType<typeof createPrivilegedPool>;
  let admin: ReturnType<typeof createAdminSupabaseClient>;
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    if (createdOrgIds.length > 0) {
      await privileged.query(
        `delete from public.organization_memberships where organization_id = any($1::uuid[])`,
        [createdOrgIds],
      );
      await privileged.query(
        `delete from public.organizations where id = any($1::uuid[])`,
        [createdOrgIds],
      );
      createdOrgIds.length = 0;
    }
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await privileged?.end();
    await prisma.$disconnect();
  });

  it("Regression 1: organization creation succeeds despite RLS RETURNING/SELECT-policy interaction", async () => {
    privileged ??= createPrivilegedPool();
    admin ??= createAdminSupabaseClient();

    const email = `tradeai-regression-1-${randomUUID()}@example.invalid`;
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (error || !created.user) {
      throw error ?? new Error("failed to create regression test user");
    }
    const userId = created.user.id;
    createdUserIds.push(userId);
    // organization_memberships.user_id FKs to public.users.id, not
    // directly to auth.users.id -- the app-side profile row has to exist
    // first (normally done on first authenticated request; see
    // lib/db/repositories/userRepository.ts).
    await userRepository.ensureProfile(userId, email);

    // Before the fix, this threw: "new row violates row-level security
    // policy for table organizations" -- Prisma's implicit RETURNING on
    // .create() required is_member_of(id) to already be true, which is
    // impossible before the founding membership row exists.
    const org = await organizationRepository.create(
      userId,
      `Regression Test Org ${randomUUID()}`,
    );
    createdOrgIds.push(org.id);

    expect(org.id).toBeTruthy();
    expect(org.name).toContain("Regression Test Org");

    const memberships = await membershipRepository.listForUser(userId);
    const founding = memberships.find((m) => m.organizationId === org.id);
    expect(founding).toBeTruthy();
    expect(founding?.role).toBe("owner");
  });

  it("Regression 2: a warmed connection's empty GUC placeholder still fails closed (zero rows, not a thrown error)", async () => {
    // Single dedicated connection, mirroring the diagnostic that found
    // this bug: reusing the exact same backend connection across two
    // transactions is what makes the placeholder-persistence quirk
    // reproducible on demand rather than intermittent.
    const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
    await client.connect();
    try {
      // Transaction 1: touch app.current_org_id, then roll back. This is
      // what "warms" the GUC placeholder to '' for the rest of this
      // connection's life.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [
        randomUUID(),
      ]);
      await client.query("ROLLBACK");

      // Confirm the connection is actually warmed (pre-fix baseline):
      // current_setting returns '' here, not NULL, proving this test
      // would have hit the bug before the fix.
      const warmed = await client.query(
        "SELECT current_setting('app.current_org_id', true) as v",
      );
      expect(warmed.rows[0].v).toBe("");

      // Transaction 2: app.current_org_id is never set. Before the fix,
      // any policy doing current_setting(...)::uuid on this connection
      // would throw "invalid input syntax for type uuid" here instead of
      // returning zero rows.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [
        randomUUID(),
      ]);
      const result = await client.query(
        "SELECT id FROM organizations WHERE id = $1::uuid",
        [randomUUID()],
      );
      await client.query("ROLLBACK");

      expect(result.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("Regression 2b: withTenantContext with orgId: null does not throw after a prior org-scoped transaction", async () => {
    // Exercises the same scenario through the real application code path
    // (not raw SQL) -- withAuthenticatedOrgContext-style usage followed
    // by an orgId: null usage, both sharing Prisma's pooled client.
    const fakeUserId = randomUUID();
    const fakeOrgId = randomUUID();

    // First, a transaction with org context set (won't find anything,
    // but exercises the org-scoped code path so the underlying pooled
    // connection gets "warmed").
    await withTenantContext(
      { userId: fakeUserId, orgId: fakeOrgId },
      (tx) => tx.$queryRaw`select 1`,
    );

    // Then a transaction that never sets org context -- must not throw.
    await expect(
      withTenantContext(
        { userId: fakeUserId, orgId: null },
        (tx) =>
          tx.$queryRaw`select id from organizations where id = ${fakeOrgId}::uuid`,
      ),
    ).resolves.toEqual([]);
  });
});
