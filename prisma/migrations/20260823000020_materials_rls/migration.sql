-- Materials RLS.
--
-- Identical pattern to 20260819000016_circuits_measurements_rls:
-- least-privilege grants to app_user, FORCE ROW LEVEL SECURITY, and a
-- single fail-closed `for all` policy using
-- nullif(current_setting(...), '')::uuid (see
-- 20260815000003_fix_rls_empty_guc for why the nullif wrapper is
-- required) combined with public.is_member_of() so membership is
-- re-derived at the SQL layer rather than trusted from the application.
--
-- Like circuits/measurements, materials has no "list across all my orgs"
-- case and no bootstrapping circularity -- a row can only be created once
-- an org context exists and has already been membership-verified by
-- resolveOrgContext -- so one uniform policy covering every command,
-- including DELETE and the implicit SELECT that RETURNING requires, is
-- sufficient.

grant select, insert, update, delete on public.materials to app_user;

alter table public.materials enable row level security;
alter table public.materials force row level security;

create policy org_scoped_all on public.materials
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );
