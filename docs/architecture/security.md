# TradeAI — Tenant Isolation & Security Foundation

Phase 0 scope: authentication, organizations, and the mechanism that
guarantees Organization A can never read or write Organization B's data.
No product features (customers, jobs, etc.) exist yet — this document
describes the foundation everything else will be built on.

## Why this needed more than "enable RLS"

Supabase's usual RLS story assumes queries go through PostgREST, which
reads a request's JWT and sets `request.jwt.claims` on the Postgres
session so policies can call `auth.uid()`. **This app uses Prisma, which
connects directly to Postgres and never goes through PostgREST.** If
Prisma's connection authenticates as the default `postgres` role (or any
table owner), RLS policies are silently skipped entirely — Postgres
exempts superusers and table owners from RLS regardless of how the
policies are written. A project can have "RLS enabled" in the dashboard
and still be fully exposed through its ORM connection. This design exists
specifically to avoid that trap.

## Two independent layers

Neither layer is "the" safety mechanism on its own — each is built to
hold even if the other has a bug.

### Layer 1 — server-verified org context + repository scoping

1. The client sends its Supabase Auth session cookie. It may also send a
   _requested_ org id (e.g. a URL segment) — this is a lookup key, never
   a trust input.
2. `getAuthenticatedUserId()` (`lib/auth/session.ts`) verifies the JWT
   server-side via Supabase Auth (`auth.getUser()`, which validates
   against Supabase, not just decodes the cookie). The only fact taken
   from the client at this point is `user_id`.
3. `resolveOrgContext(userId, requestedOrgId)` looks up
   `organization_memberships` for that exact `(userId, requestedOrgId)`
   pair. No row → `ForbiddenOrgAccessError`. This is the only place a
   request's org context becomes trusted, and it comes from a fresh
   database read keyed on the verified user id — never from a JWT custom
   claim (which could go stale before a token refresh if membership
   changes).
4. All tenant-table access goes through `lib/db/repositories/*`, whose
   functions require an already-scoped transaction client. Route/service
   code never calls `prisma.organization.*` / `prisma.user.*` /
   `prisma.organizationMembership.*` directly — an eslint rule
   (`no-restricted-syntax` in `eslint.config.mjs`) makes that a lint
   error outside the repository files.

### Layer 2 — PostgreSQL RLS, configured so it can't silently no-op

- The app connects at runtime as `app_user`: **not** a superuser, **not**
  the owner of any tenant table (the migration role owns them), and every
  tenant table has `FORCE ROW LEVEL SECURITY` set (see
  `prisma/migrations/20260815000002_tenant_rls/migration.sql`).
- Every tenant-scoped request runs inside a Prisma interactive
  transaction (`withTenantContext`, `lib/db/tenantContext.ts`) that opens
  with `SELECT set_config('app.current_user_id', <verified>, true)` and,
  once an org is selected, `SELECT set_config('app.current_org_id',
<verified>, true)`. The third argument (`true`) makes this
  transaction-local — the functional equivalent of `SET LOCAL` — so it
  automatically reverts at commit/rollback and can never leak onto a
  later, unrelated request that reuses the same pooled connection.
- Policies are **fail-closed**: `current_setting(name, true)` returns
  `NULL` the first time a session ever references a given setting, and
  `NULL = x` / `NULL::uuid` are never `TRUE` in a `USING`/`CHECK` clause,
  so a missing or malformed setting yields zero rows — never an error,
  never a leak. **Caveat, found by running the security suite against a
  real database:** once a setting has been referenced at all on a given
  backend connection — including inside a transaction that was later
  rolled back — Postgres's placeholder GUC mechanism makes its "unset"
  value `''` (empty string) for the rest of that connection's life, not
  `NULL` again. Under connection pooling, backend connections reach this
  "warmed" state almost immediately. Casting `''` directly to `::uuid`
  throws (`invalid input syntax for type uuid`) instead of failing
  closed silently. Every `current_setting(...)::uuid` cast in the
  policies is therefore written as
  `nullif(current_setting(...), '')::uuid` (migration
  `20260815000003_fix_rls_empty_guc`), which converts the warmed
  empty-string state back to `NULL` before casting. See
  `tests/security/regression.test.ts` for a test that reproduces the
  exact warmed-connection scenario.
- **Membership-gated reads vs. context-gated writes are intentionally
  different.** `organizations`' SELECT policy (`select_member_orgs`) is
  `is_member_of(id)` alone — it does **not** also require
  `app.current_org_id` to be set. This is deliberate: "list my
  organizations" and "which orgs am I in" have to work before any single
  org has been selected, so read access to a row is gated purely by real
  membership. Mutations are different — `update_own_org` /
  `delete_own_org` additionally require
  `id = current_setting('app.current_org_id')::uuid`, so a write can
  only ever land on whichever org is currently selected, even for a
  legitimate member of several orgs. Don't mistake "a member can read
  their own org with no context set" for a gap — it isn't one; it's what
  makes org listing/switching possible at all. Test 5 in
  `tests/security/tenant-isolation.test.ts` exercises the write side of
  this (missing context blocks an `UPDATE`), not the read side, for
  exactly this reason.
- Policies do not just compare `current_setting('app.current_org_id')` to
  a row's `organization_id`. They call `public.is_member_of(org_id)`,
  which **independently re-derives membership** from
  `organization_memberships` using `app.current_user_id`. This is what
  makes Layer 2 genuine defense-in-depth rather than a rubber stamp on
  whatever Layer 1 already decided: even if application code somehow set
  `app.current_org_id` without having called `resolveOrgContext` first
  (a bug, not the intended path), the policy still requires a real
  membership row before returning any data. See Test 6 in
  `tests/security/tenant-isolation.test.ts`, which exercises exactly this
  scenario.

**What Layer 2 cannot do:** it cannot protect against `withTenantContext`
being called with an attacker-controlled `userId` — `app.current_user_id`
itself is only ever trustworthy because `getAuthenticatedUserId()`
verified it against Supabase Auth first. That's why `withTenantContext`
is import-restricted (eslint `no-restricted-imports`) to
`lib/auth/session.ts` and `lib/db/repositories/*` only — the places
responsible for establishing that trust in the first place.

## Runtime role vs. migration role

|                    | Runtime (`app_user`)                                           | Migration (`postgres`)                                                                        |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Used by            | The running app (`lib/db/prisma.ts`)                           | `prisma migrate deploy` / `prisma migrate dev` only                                           |
| Connection string  | `DATABASE_URL` (pooled, Supavisor transaction mode, port 6543) | `DIRECT_URL` (direct, port 5432)                                                              |
| Superuser          | No                                                             | Effectively yes, within the project                                                           |
| Owns tenant tables | No                                                             | Yes                                                                                           |
| Subject to RLS     | Yes, forced                                                    | N/A (owner/superuser — RLS doesn't apply, which is exactly why it must never run app queries) |
| DDL privileges     | None (`Test 9`)                                                | Full                                                                                          |

**Prisma 7 note:** earlier Prisma versions supported a `directUrl` field
directly in the datasource config, which would have been the obvious
place to declare this split. Prisma 7.9's `prisma.config.ts` schema no
longer has that field (verified against
`node_modules/@prisma/config/dist/index.d.ts` — some migration guides
still mention it, but it doesn't exist in this version). Given that,
`prisma.config.ts` here is used purely as the CLI's migration
configuration and points at `DIRECT_URL`; the app's actual runtime
connection (`lib/db/prisma.ts`) is independent code that reads
`DATABASE_URL` directly via `@prisma/adapter-pg` and never consults
`prisma.config.ts` at all. The two are decoupled by construction, not by
a shared config field.

Bootstrapping order: the `app_user` role is created by the RLS migration,
so it does not exist until that migration has been applied with the
migration role. `DATABASE_URL` cannot work until then. The role's
password is deliberately not in the migration SQL — set it out of band
(`ALTER ROLE app_user WITH PASSWORD '...'`) immediately after migrating,
and store it only in the deployment secret manager.

## Connection pooling — the leak vector that isn't hypothetical

Supabase's pooled connection (Supavisor, transaction mode) keeps one
transaction pinned to one backend connection for that transaction's
duration, and only reassigns connections _between_ transactions. That
means:

- `set_config(..., true)` (`SET LOCAL` equivalent) inside a
  `prisma.$transaction()` is safe — it cannot bleed into a different
  request.
- A bare, non-transactional `SET app.current_org_id = ...` would **not**
  be safe — it could persist on a connection the pooler later hands to an
  unrelated request from a different tenant. This codebase never does
  this; `withTenantContext` is the only place `set_config` is called, and
  it always passes `is_local = true` inside an interactive transaction.
- Test 7 exercises this directly: many concurrent transactions for two
  different orgs, asserting no cross-contamination.

## Secrets

- `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_SERVICE_ROLE_KEY` are server-only
  and read exclusively from environment variables — never committed (see
  `.gitignore`), never sent to the client.
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are safe to
  expose to the browser; their safety comes from Supabase's own
  anon-key/RLS scoping on that side, not from secrecy.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely (it's how
  `tests/security/helpers.ts` creates/deletes synthetic test users via
  the Auth Admin API). It must never be used in ordinary request-handling
  code — only in narrow, explicitly-reviewed administrative paths.

## Why client-provided org ids are never trusted

A `requestedOrgId` in a URL or request body only ever functions as an
index into `organization_memberships` (Layer 1, step 3). It never
reaches a query's `WHERE`/RLS context until that lookup has succeeded for
the _specific, verified_ `user_id` from step 2. Sending a different org's
real id, a random UUID, or no id at all all resolve the same way: no
membership row found → `ForbiddenOrgAccessError`, before any tenant table
is touched.

## Where to look

| Concern                                                                   | File                                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Verify session, resolve org, the one chokepoint route handlers should use | `lib/auth/session.ts`                                                        |
| Set transaction-local tenant context                                      | `lib/db/tenantContext.ts`                                                    |
| Runtime Prisma connection (app_user, pooled)                              | `lib/db/prisma.ts`                                                           |
| Tenant-scoped queries                                                     | `lib/db/repositories/*.ts`                                                   |
| Base schema                                                               | `prisma/migrations/20260815000001_init/migration.sql`                        |
| Roles, RLS, policies, `is_member_of`                                      | `prisma/migrations/20260815000002_tenant_rls/migration.sql`                  |
| Empty-GUC-placeholder fix (`nullif` casts)                                | `prisma/migrations/20260815000003_fix_rls_empty_guc/migration.sql`           |
| Enforcement of the chokepoints above                                      | `eslint.config.mjs`                                                          |
| Proof it actually works                                                   | `tests/security/tenant-isolation.test.ts`, `tests/security/db-roles.test.ts` |
| Regression coverage for the two bugs found running the suite live         | `tests/security/regression.test.ts`                                          |
