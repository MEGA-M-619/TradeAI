-- Tenant isolation foundation: runtime role, RLS, fail-closed policies.
--
-- This migration must be applied with a privileged connection (the
-- Supabase `postgres` role, via DIRECT_URL) — the same connection used to
-- run migration 20260815000001_init. It creates a SEPARATE, deliberately
-- unprivileged role that the application will use at runtime instead.
--
-- See docs/architecture/security.md for the full design rationale. In
-- short: the migration role owns these tables; app_user does not, is not
-- a superuser, and is subject to RLS with no bypass.

-- ============================================================================
-- 1. Link users.id to Supabase Auth's auth.users.id.
--
-- This lives outside the tables Prisma otherwise manages (auth.users is
-- owned by Supabase, not this project), so it is added here rather than
-- expressed in schema.prisma.
-- ============================================================================

alter table public.users
  add constraint users_id_fkey_auth_users
  foreign key (id) references auth.users (id) on delete cascade;

-- ============================================================================
-- 2. Dedicated least-privilege runtime role.
--
-- Password is intentionally NOT set here — do not hardcode secrets in a
-- migration file that lives in version control. Set it out-of-band
-- immediately after this migration runs (Supabase SQL editor or psql),
-- and store the value only in the deployment secret manager:
--
--   ALTER ROLE app_user WITH PASSWORD '<generated-secret>';
--
-- Then use it as the credentials in DATABASE_URL (the pooled connection
-- string) — never in DIRECT_URL, and never for the connection that ran
-- this migration.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user with login noinherit;
  end if;
end
$$;

comment on role app_user is
  'TradeAI application runtime role. Non-superuser, does not own tenant '
  'tables, subject to RLS with no bypass. Used only via the pooled '
  'DATABASE_URL connection string. Never used for migrations.';

-- Least-privilege grants: row-level data access only. No DDL, no
-- ownership, no BYPASSRLS, no SUPERUSER.
grant usage on schema public to app_user;
grant select, insert, update, delete on public.organizations to app_user;
grant select, insert, update, delete on public.users to app_user;
grant select, insert, update, delete on public.organization_memberships to app_user;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;

-- ============================================================================
-- 3. Row Level Security — enabled AND forced.
--
-- FORCE is what makes this real: without it, Postgres exempts the table
-- OWNER from RLS entirely, regardless of how the policies below are
-- written. These tables are owned by the migration role (`postgres`),
-- not by app_user, and FORCE ensures that even table-owner-equivalent
-- access through any future role misconfiguration still can't silently
-- bypass these policies for the app_user role specifically. (Superusers
-- are always exempt from RLS by Postgres design, forced or not — app_user
-- must never be granted superuser, which is why Test 8 in the security
-- suite asserts rolsuper = false for this role on every deploy.)
-- ============================================================================

alter table public.organizations enable row level security;
alter table public.organizations force row level security;

alter table public.organization_memberships enable row level security;
alter table public.organization_memberships force row level security;

alter table public.users enable row level security;
alter table public.users force row level security;

-- ============================================================================
-- 4. Tenant-context helper.
--
-- Re-derives "is this session's verified user actually a member of this
-- org" independently at the SQL layer, rather than trusting
-- app.current_org_id alone. This is what makes RLS genuine defense-in-
-- depth: even if application code somehow set app.current_org_id without
-- having gone through the membership check in lib/auth/session.ts first,
-- this function still requires a real organization_memberships row tying
-- app.current_user_id to the target org before any row becomes visible.
--
-- STABLE (not IMMUTABLE): current_setting() can differ across statements/
-- transactions, but is constant within a single table scan, which is
-- exactly what STABLE promises.
-- ============================================================================

create or replace function public.is_member_of(target_org uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = current_setting('app.current_user_id', true)::uuid
  );
$$;

grant execute on function public.is_member_of(uuid) to app_user;

-- ============================================================================
-- 5. Fail-closed policies.
--
-- current_setting(name, true) returns NULL when the setting was never
-- made in this transaction (missing tenant context). `NULL = x` and
-- `... ::uuid` on NULL both evaluate to NULL, which SQL treats as false
-- in a USING/CHECK clause -- so a missing or malformed setting yields
-- zero rows, never an error and never a leak. The same is true if
-- current_user_id is set but doesn't resolve to any real membership row:
-- is_member_of() returns false, zero rows.
--
-- Principle, restated:
--   missing org context  -> no tenant rows
--   wrong/unowned context -> no tenant rows
--   correct, membership-verified context -> only that organization's rows
-- ============================================================================

-- --- organizations ---------------------------------------------------------

-- Read: any org the session's verified user actually belongs to. This
-- covers both "list my organizations" (no org selected yet) and "read the
-- currently selected organization" with one policy.
create policy select_member_orgs on public.organizations
  for select
  using (public.is_member_of(id));

-- Create: any authenticated user may create a brand-new organization --
-- there is by definition no existing org context to check yet. The
-- corresponding first membership row (creator becomes owner) is inserted
-- in the same transaction, immediately after which app.current_org_id is
-- set to the new org's id so all *subsequent* statements in that
-- transaction go through the standard org-scoped policies below, not this
-- one. See lib/db/repositories/organizationRepository.ts `create`.
create policy insert_org_as_authenticated_user on public.organizations
  for insert
  with check (current_setting('app.current_user_id', true) is not null);

-- Update/delete: must be acting within that org's selected context AND be
-- a verified member (belt-and-suspenders: the org_id match alone would
-- already be gated by resolveOrgContext at the app layer; is_member_of
-- re-derives it independently at the SQL layer too).
create policy update_own_org on public.organizations
  for update
  using (
    id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(id)
  )
  with check (
    id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(id)
  );

create policy delete_own_org on public.organizations
  for delete
  using (
    id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(id)
  );

-- --- organization_memberships -----------------------------------------------

-- Read: a session may always see its own membership rows (needed to list
-- "my organizations" and to run the membership check itself, before any
-- org context is selected), OR the full member list of any org it belongs
-- to (needed once an org context is selected, e.g. an "org members" page).
create policy select_own_memberships on public.organization_memberships
  for select
  using (user_id = current_setting('app.current_user_id', true)::uuid);

create policy select_org_peer_memberships on public.organization_memberships
  for select
  using (public.is_member_of(organization_id));

-- Insert: a session may add ITSELF (never anyone else) as a member of
-- whichever org is currently selected in context. Deliberately does NOT
-- require public.is_member_of(organization_id) here, unlike the other
-- membership policies -- requiring it would be circular for the exact
-- case this has to support: a brand-new organization's founding
-- membership row, where by definition no membership exists yet for that
-- org. Self-insertion-only is what keeps this safe despite that: you can
-- never use this policy to add a different user_id, and you can only
-- target the org your session has already been placed into by
-- organizationRepository.create (immediately after creating that org) or
-- by withAuthenticatedOrgContext (which only ever sets org context after
-- resolveOrgContext has verified you belong there already). Adding OTHER
-- users to an org (a future "invite teammate" feature) will need a
-- separate, more privileged policy -- not needed in Phase 0, which has no
-- invite flow.
create policy insert_own_membership on public.organization_memberships
  for insert
  with check (
    organization_id = current_setting('app.current_org_id', true)::uuid
    and user_id = current_setting('app.current_user_id', true)::uuid
  );

create policy update_org_scoped_membership on public.organization_memberships
  for update
  using (
    organization_id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(organization_id)
  );

create policy delete_org_scoped_membership on public.organization_memberships
  for delete
  using (
    organization_id = current_setting('app.current_org_id', true)::uuid
    and public.is_member_of(organization_id)
  );

-- --- users -------------------------------------------------------------

-- Read: your own profile row, always -- plus any other user's profile row
-- if you share at least one organization with them (needed for member-
-- list views). No org-context requirement, since "who am I on a team
-- with" is not scoped to whichever single org happens to be selected.
create policy select_self on public.users
  for select
  using (id = current_setting('app.current_user_id', true)::uuid);

create policy select_org_peers on public.users
  for select
  using (
    exists (
      select 1
      from public.organization_memberships mine
      join public.organization_memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = current_setting('app.current_user_id', true)::uuid
        and theirs.user_id = users.id
    )
  );

-- Write: a session may only ever create or update the profile row that
-- matches its own verified identity. There is deliberately no delete
-- policy for Phase 0 -- profile deletion is out of scope, and with no
-- permissive DELETE policy present, RLS denies it by default.
create policy insert_self on public.users
  for insert
  with check (id = current_setting('app.current_user_id', true)::uuid);

create policy update_self on public.users
  for update
  using (id = current_setting('app.current_user_id', true)::uuid)
  with check (id = current_setting('app.current_user_id', true)::uuid);
