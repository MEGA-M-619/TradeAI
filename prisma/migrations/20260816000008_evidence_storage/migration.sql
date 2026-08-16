-- Phase 2 storage: the `job-evidence` bucket and its RLS.
--
-- WHY THIS CANNOT REUSE THE PHASE 0 MECHANISM
--
-- Every other tenant table is gated by public.is_member_of(), which
-- derives the caller from the app.current_user_id GUC that
-- withTenantContext sets on the Prisma/app_user connection. Supabase
-- Storage never touches that connection: requests arrive at the Storage
-- API as role `authenticated` carrying a verified JWT, so the caller has
-- to be derived from auth.uid() instead. That is the only reason a second
-- membership function exists -- the trust model is unchanged, only the
-- source of the caller's identity differs.
--
-- Verified empirically against the live project before this was written
-- (same approach that surfaced the Phase 0 RLS bugs):
--   * createSignedUploadUrl is gated by the INSERT policy
--   * createSignedUrl (download) is gated by the SELECT policy
--   * remove() is gated by the DELETE policy
--   * no UPDATE policy is required for a full mint -> upload -> download
--     -> delete cycle, so none is granted (the app never upserts)
--   * cross-org upload, download-URL minting, listing and deletion are
--     all denied; anonymous access is denied
--   * bucket file_size_limit / allowed_mime_types are enforced by Storage
--     at upload time -- which is what makes direct-to-storage upload
--     acceptable given the application server never sees the bytes
--   * remove() DENIES SILENTLY: it returns no error and an empty data
--     array rather than failing, so callers must check the returned
--     payload instead of trusting the absence of an error.

-- Private bucket. The limits here are a real enforcement boundary, not a
-- hint: they are applied by Storage itself on the direct upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-evidence',
  'job-evidence',
  false,
  10485760, -- 10 MiB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- SECURITY DEFINER is required, not incidental: `authenticated` has no
-- grant on organization_memberships, and that table's own RLS is keyed on
-- the app.current_user_id GUC, which is unset in a Storage request. The
-- function is safe because the only caller-controlled input is
-- target_org; the identity half is auth.uid(), taken from the verified
-- JWT and never from an argument. search_path is pinned so the definer
-- context cannot be redirected to an attacker-controlled schema.
create or replace function public.is_member_of_auth(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_member_of_auth(uuid) from public;
grant execute on function public.is_member_of_auth(uuid) to authenticated;

-- Returns the owning organization for a well-formed evidence object name,
-- or NULL for anything else (NULL then fails the membership check, so the
-- policy fails closed).
--
-- The strict UUID-triplet regex is load-bearing. storage.foldername()
-- alone is NOT sufficient -- verified directly:
--   foldername('orgA/../orgB/job/ev'))[1]  -> 'orgA'
-- so a policy keyed only on segment 1 would happily accept a
-- traversal-shaped name. It also returns '' for a leading slash, which
-- would throw on a ::uuid cast (the same failure shape as the Phase 0
-- empty-GUC bug). Requiring all three segments to be literal lowercase
-- UUIDs makes both unrepresentable.
--
-- Lowercase-only is deliberate: Postgres renders uuids lowercase, so the
-- application only ever produces lowercase keys, and rejecting the
-- uppercase spelling prevents two different names aliasing one logical
-- object.
create or replace function public.evidence_path_org(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when object_name ~ ('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                     || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                     || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then (storage.foldername(object_name))[1]::uuid
    else null
  end;
$$;

revoke all on function public.evidence_path_org(text) from public;
grant execute on function public.evidence_path_org(text) to authenticated;

drop policy if exists evidence_select on storage.objects;
drop policy if exists evidence_insert on storage.objects;
drop policy if exists evidence_update on storage.objects;
drop policy if exists evidence_delete on storage.objects;

create policy evidence_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'job-evidence'
    and public.is_member_of_auth(public.evidence_path_org(name))
  );

create policy evidence_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'job-evidence'
    and public.is_member_of_auth(public.evidence_path_org(name))
  );

create policy evidence_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'job-evidence'
    and public.is_member_of_auth(public.evidence_path_org(name))
  );
