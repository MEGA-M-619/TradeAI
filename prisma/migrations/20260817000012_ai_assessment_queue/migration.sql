-- Phase 3: queue mechanics.
--
-- 1. `selected_evidence_ids` on ai_assessment: the technician's evidence
--    selection, recorded synchronously at request time (a live, verified,
--    authorized act) as a handoff to the async executor. It exists
--    because the executor runs deployment-agnostically -- possibly with
--    no live user session at all (an external cron, a retry) -- so it
--    cannot re-derive "what was selected" from anything session-scoped.
--    Once ai_assessment_input rows exist for a run, those are the source
--    of truth for what was actually sent to the model; this column is
--    kept permanently only for audit (requested vs. actually used).
--
-- 2. list_queued_ai_assessments(): a second narrow SECURITY DEFINER
--    function alongside reap_stuck_ai_assessments() from
--    20260817000011_ai_assessment_reaper, for the same structural reason
--    -- app_user's RLS-scoped connection cannot see across organizations,
--    but draining the queue is inherently cross-tenant. Returns only the
--    three columns needed to resume a run (id, organization_id,
--    requested_by_user_id) -- no tenant content, same discipline as the
--    reaper.

ALTER TABLE "ai_assessment" ADD COLUMN "selected_evidence_ids" TEXT[] NOT NULL DEFAULT '{}';

create or replace function public.list_queued_ai_assessments(max_rows integer default 20)
returns table (id uuid, organization_id uuid, requested_by_user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.organization_id, a.requested_by_user_id
    from public.ai_assessment a
   where a.status = 'queued'
   order by a.created_at asc
   limit greatest(max_rows, 0);
$$;

revoke all on function public.list_queued_ai_assessments(integer) from public;
grant execute on function public.list_queued_ai_assessments(integer) to app_user;
