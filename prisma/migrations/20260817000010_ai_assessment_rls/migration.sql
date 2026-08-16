-- Phase 3 RLS: all nine AI-assessment tables.
--
-- Identical pattern to customers/jobs/evidence: least-privilege grants to
-- app_user, FORCE ROW LEVEL SECURITY, and a single fail-closed `for all`
-- policy using nullif(current_setting(...), '')::uuid (see
-- 20260815000003_fix_rls_empty_guc for why the nullif wrapper is required)
-- combined with public.is_member_of() so membership is re-derived at the
-- SQL layer rather than trusted from the application.
--
-- Every one of the nine tables carries organization_id directly, including
-- the six child tables that could technically derive it via a join to
-- ai_assessment -- the same deliberate denormalization Customer/Job/
-- Evidence already use, so every policy here is a cheap equality check
-- with no join, and every table's enforcement is uniform and independently
-- auditable rather than depending on a shared subquery being correct.
--
-- This governs the assessment *metadata* only. The photographs referenced
-- by ai_assessment_input remain governed by Evidence's own RLS and by the
-- job-evidence Storage bucket policies from Phase 2 -- unchanged here.

grant select, insert, update, delete on public.ai_assessment                to app_user;
grant select, insert, update, delete on public.ai_assessment_input          to app_user;
grant select, insert, update, delete on public.ai_assessment_finding        to app_user;
grant select, insert, update, delete on public.ai_assessment_citation       to app_user;
grant select, insert, update, delete on public.ai_assessment_test           to app_user;
grant select, insert, update, delete on public.ai_assessment_question       to app_user;
grant select, insert, update, delete on public.ai_assessment_safety_warning to app_user;
grant select, insert, update, delete on public.technician_verdict           to app_user;
grant select, insert, update, delete on public.ai_usage_ledger              to app_user;

alter table public.ai_assessment                enable row level security;
alter table public.ai_assessment                force row level security;
alter table public.ai_assessment_input          enable row level security;
alter table public.ai_assessment_input          force row level security;
alter table public.ai_assessment_finding        enable row level security;
alter table public.ai_assessment_finding        force row level security;
alter table public.ai_assessment_citation       enable row level security;
alter table public.ai_assessment_citation       force row level security;
alter table public.ai_assessment_test           enable row level security;
alter table public.ai_assessment_test           force row level security;
alter table public.ai_assessment_question       enable row level security;
alter table public.ai_assessment_question       force row level security;
alter table public.ai_assessment_safety_warning enable row level security;
alter table public.ai_assessment_safety_warning force row level security;
alter table public.technician_verdict           enable row level security;
alter table public.technician_verdict           force row level security;
alter table public.ai_usage_ledger              enable row level security;
alter table public.ai_usage_ledger              force row level security;

create policy org_scoped_all on public.ai_assessment
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_input
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_finding
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_citation
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_test
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_question
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_assessment_safety_warning
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.technician_verdict
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );

create policy org_scoped_all on public.ai_usage_ledger
  for all
  using (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  )
  with check (
    organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    and public.is_member_of(organization_id)
  );
