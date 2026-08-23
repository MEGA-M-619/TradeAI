-- Quotes RLS.
--
-- Identical pattern to 20260823000020_materials_rls and
-- 20260819000016_circuits_measurements_rls: least-privilege grants to
-- app_user, FORCE ROW LEVEL SECURITY, and a single fail-closed `for all`
-- policy using nullif(current_setting(...), '')::uuid (see
-- 20260815000003_fix_rls_empty_guc for why the nullif wrapper is
-- required) combined with public.is_member_of() so membership is
-- re-derived at the SQL layer rather than trusted from the application.
--
-- Both tables have no "list across all my orgs" case and no bootstrapping
-- circularity -- a row can only be created once an org context exists and
-- has already been membership-verified by resolveOrgContext -- so one
-- uniform policy covering every command, including DELETE and the
-- implicit SELECT that RETURNING requires, is sufficient for both.

grant select, insert, update, delete on public.quotes to app_user;

alter table public.quotes enable row level security;
alter table public.quotes force row level security;

create policy org_scoped_all on public.quotes
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

grant select, insert, update, delete on public.quote_line_items to app_user;

alter table public.quote_line_items enable row level security;
alter table public.quote_line_items force row level security;

create policy org_scoped_all on public.quote_line_items
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );
