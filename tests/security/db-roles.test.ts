import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  dbTestsEnabled,
  createPrivilegedPool,
  requireEnv,
  roleNameFromConnectionString,
} from "./helpers";

// Tests 8-9 from the Phase 0 spec. Requires a live Supabase project.
// Skipped by default.
describe.skipIf(!dbTestsEnabled)("runtime database role audit", () => {
  // Constructed in beforeAll, not here: describe.skipIf still evaluates
  // this describe body (only the `it`s are skipped), so anything that
  // reads env vars eagerly must not run at this scope.
  let privileged: Pool;

  beforeAll(() => {
    privileged = createPrivilegedPool();
  });

  afterAll(async () => {
    // Guard against beforeAll having failed before `privileged` was
    // assigned -- otherwise a setup failure surfaces as a second,
    // confusing "Cannot read properties of undefined" error on top of
    // the real one.
    await privileged?.end();
  });

  it("Test 8: app_user is not a superuser, does not bypass RLS, does not own tenant tables, and RLS is forced on every tenant table", async () => {
    const { rows: roleRows } = await privileged.query(
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'app_user'`,
    );
    expect(roleRows).toHaveLength(1);
    expect(roleRows[0].rolsuper).toBe(false);
    expect(roleRows[0].rolbypassrls).toBe(false);

    const { rows: tableRows } = await privileged.query(`
      select
        c.relname,
        c.relowner::regrole::text as owner,
        c.relrowsecurity,
        c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('organizations', 'users', 'organization_memberships')
      order by c.relname
    `);

    expect(tableRows).toHaveLength(3);
    for (const row of tableRows) {
      expect(row.owner, `${row.relname} owner`).not.toBe("app_user");
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it("Test 9: the runtime connection cannot perform DDL and is a genuinely different role from the migration connection", async () => {
    const runtimeUser = roleNameFromConnectionString(
      requireEnv("DATABASE_URL"),
    );
    const migrationUser = roleNameFromConnectionString(
      requireEnv("DIRECT_URL"),
    );

    // If these are ever the same role, the "runtime role has no admin
    // privileges" property can't hold no matter what the grants say --
    // this is the check that would catch someone pointing DATABASE_URL
    // back at the `postgres` role "just for now."
    expect(runtimeUser).not.toBe(migrationUser);

    const runtimePool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      await expect(
        runtimePool.query(
          `create table public._tradeai_privilege_escalation_probe (id int)`,
        ),
      ).rejects.toThrow();
    } finally {
      // Best-effort cleanup in case some future grant change ever makes
      // this succeed -- we want the test to fail loudly, not leave debris.
      await privileged
        .query(
          `drop table if exists public._tradeai_privilege_escalation_probe`,
        )
        .catch(() => {});
      await runtimePool.end();
    }
  });
});
