import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

/**
 * These tests exercise real tenant isolation against a live Supabase
 * Postgres instance -- they create and delete real auth users. They are
 * opt-in (require RUN_DB_SECURITY_TESTS=true) rather than gated purely on
 * env-var presence, so they never run accidentally just because
 * DATABASE_URL happens to be set for an unrelated reason (e.g. `next dev`).
 *
 * Point this at a dedicated Supabase project (or at minimum a project
 * where creating/deleting a couple of test users and orgs is acceptable),
 * never at production.
 */
export const dbTestsEnabled = process.env.RUN_DB_SECURITY_TESTS === "true";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required when RUN_DB_SECURITY_TESTS=true. See .env.example.`,
    );
  }
  return value;
}

/** Service-role client, used only to create/delete synthetic test users
 * via the Auth Admin API -- never used to exercise tenant-isolation
 * behavior itself. */
export function createAdminSupabaseClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** A raw connection using the privileged migration role (DIRECT_URL),
 * for test fixture cleanup and role-audit queries only -- never used to
 * exercise the runtime behavior under test, which must always go through
 * app_user via DATABASE_URL. */
export function createPrivilegedPool() {
  return new Pool({ connectionString: requireEnv("DIRECT_URL") });
}

export function roleNameFromConnectionString(connectionString: string): string {
  const match = /^postgresql:\/\/([^:@/]+)/.exec(connectionString);
  if (!match) {
    throw new Error(`Could not parse role name from connection string`);
  }
  return match[1];
}
