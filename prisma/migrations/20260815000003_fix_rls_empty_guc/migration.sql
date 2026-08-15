-- Fixes a PostgreSQL GUC-placeholder quirk discovered while running the
-- Phase 0 security suite against a real Supabase database.
--
-- Once a custom setting like app.current_org_id has been referenced at
-- all on a backend connection -- including inside a transaction that was
-- later rolled back -- its "unset" value for the rest of that
-- connection's lifetime becomes '' (empty string), not NULL. Confirmed
-- directly: SET via set_config(..., true) -> ROLLBACK -> a later
-- transaction on the SAME backend connection that never touches the
-- setting still reads back '' from current_setting(name, true), not
-- NULL. Under connection pooling, backend connections reach this
-- "warmed" state almost immediately, and it persists across unrelated
-- later transactions that reuse the same backend connection.
--
-- Every policy that did `current_setting(...)::uuid` therefore risked
-- casting '' to uuid, which raises "invalid input syntax for type uuid"
-- -- a thrown error, not the intended clean zero-rows result -- any time
-- a transaction legitimately leaves that setting unset (e.g. no org
-- selected yet). No cross-tenant data was ever at risk from this (an
-- error is not a leak), but it broke the documented guarantee that
-- missing context fails closed *silently*, with zero rows, not an
-- exception.
--
-- Fix: wrap every such cast as `nullif(current_setting(...), '')::uuid`.
-- nullif converts the warmed empty-string placeholder back to NULL
-- before the cast, so `NULL::uuid` (safely NULL) is what a genuinely
-- unset setting produces again, regardless of connection history.
--
-- See docs/architecture/security.md and
-- tests/security/regression.test.ts for the regression test that
-- reproduces the exact "warmed connection" scenario.

create or replace function public.is_member_of(target_org uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );
$$;

-- --- organizations ---------------------------------------------------------

alter policy insert_org_as_authenticated_user on public.organizations
  with check (nullif(current_setting('app.current_user_id', true), '') is not null);

alter policy update_own_org on public.organizations
  using (
    id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(id)
  )
  with check (
    id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(id)
  );

alter policy delete_own_org on public.organizations
  using (
    id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(id)
  );

-- --- organization_memberships -----------------------------------------------

alter policy select_own_memberships on public.organization_memberships
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

alter policy insert_own_membership on public.organization_memberships
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
  );

alter policy update_org_scoped_membership on public.organization_memberships
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

alter policy delete_org_scoped_membership on public.organization_memberships
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

-- --- users -------------------------------------------------------------

alter policy select_self on public.users
  using (id = nullif(current_setting('app.current_user_id', true), '')::uuid);

alter policy select_org_peers on public.users
  using (
    exists (
      select 1
      from public.organization_memberships mine
      join public.organization_memberships theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
        and theirs.user_id = users.id
    )
  );

alter policy insert_self on public.users
  with check (id = nullif(current_setting('app.current_user_id', true), '')::uuid);

alter policy update_self on public.users
  using (id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- select_member_orgs on organizations needs no direct change -- it only
-- calls is_member_of(id), which is already fixed above.
