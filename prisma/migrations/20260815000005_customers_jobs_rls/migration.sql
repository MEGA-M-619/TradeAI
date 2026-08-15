-- Phase 1 RLS: customers, jobs.
--
-- Same pattern as Phase 0's tenant tables: least-privilege grants to
-- app_user, FORCE ROW LEVEL SECURITY, fail-closed policies using
-- nullif(current_setting(...), '')::uuid (see
-- 20260815000003_fix_rls_empty_guc for why the nullif wrapper is
-- required) combined with public.is_member_of() for independent
-- re-derivation of membership at the SQL layer.
--
-- Unlike organizations, customers and jobs have no "list across all my
-- orgs, before any org is selected" use case and no bootstrapping
-- circularity (a customer/job can only ever be created once an org
-- context already exists and has already been membership-verified by
-- resolveOrgContext) -- so a single `for all` policy per table, applied
-- uniformly to every command including the implicit SELECT check that
-- RETURNING requires, is sufficient. See docs/architecture/security.md.

grant select, insert, update, delete on public.customers to app_user;
grant select, insert, update, delete on public.jobs to app_user;

alter table public.customers enable row level security;
alter table public.customers force row level security;

alter table public.jobs enable row level security;
alter table public.jobs force row level security;

create policy org_scoped_all on public.customers
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.jobs
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );
