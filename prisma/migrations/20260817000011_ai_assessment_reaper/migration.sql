-- Phase 3: stuck-assessment reaper.
--
-- WHY THIS NEEDS A SECURITY DEFINER FUNCTION RATHER THAN AN APP QUERY
--
-- The runtime connection (app_user) is subject to FORCE ROW LEVEL SECURITY
-- on every table here, and every policy requires app.current_org_id to be
-- set to a single org for the current transaction. A stuck-run sweep is
-- inherently cross-tenant -- "every org's rows stuck past a timeout" -- so
-- there is no org context an ordinary request could set that would let
-- app_user see across all of them. Elevating app_user itself, or adding a
-- new privileged connection to runtime code, would undo the least-
-- privilege boundary documented in docs/architecture/security.md ("must
-- never be used in ordinary request-handling code").
--
-- The precedent this follows is is_member_of_auth from
-- 20260816000008_evidence_storage: a narrow SECURITY DEFINER function,
-- owned by the migration role, that bridges a specific legitimate gap
-- without granting anything broader. This function is deliberately unable
-- to do anything except transition ai_assessment rows past a timeout to
-- `failed` -- it touches no other table, exposes no tenant content (the
-- return set is id + organization_id only, for logging "reaped N for org
-- X", never findings/evidence/citations), and runs no dynamic SQL.
--
-- Two triggers are expected to call this, matching the deployment-agnostic
-- executor design: (1) opportunistically, inline, whenever the status-
-- polling GET endpoint is hit for any assessment -- cheap, and means a
-- stuck run resolves for the user polling it without any external
-- scheduler; (2) POST /api/internal/assessments/reap, shared-secret-gated,
-- for whatever cron mechanism the eventual host provides.

create or replace function public.reap_stuck_ai_assessments(
  running_timeout interval default interval '5 minutes',
  queued_timeout interval default interval '15 minutes'
)
returns table (id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.ai_assessment a
     set status = 'failed',
         failure_category = 'timeout',
         error_message = 'Assessment did not complete before the processing timeout and was reaped.',
         updated_at = now()
   where (a.status = 'running' and a.claimed_at < now() - running_timeout)
      or (a.status = 'queued'  and a.created_at < now() - queued_timeout)
  returning a.id, a.organization_id;
end;
$$;

revoke all on function public.reap_stuck_ai_assessments(interval, interval) from public;
grant execute on function public.reap_stuck_ai_assessments(interval, interval) to app_user;
