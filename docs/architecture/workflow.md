# TradeAI — Electrician Workflow (Phase 5)

Phase 5 exposed the deterministic engines built in Phases 1–4F through the job workspace, so an electrician can run the whole loop without developer tools, direct API calls, or database access. It added **no new business logic** — every rule, evaluation, and verdict still comes from the existing server-side modules.

## The workflow

All of it lives on one page: `/orgs/[orgId]/jobs/[jobId]`.

| Step | Where | Backed by |
|---|---|---|
| 1. Job & customer context | Job workspace header | Phase 1 `Job`/`Customer` |
| 2. Reported problem | Problem card | `Job.problemDescription` |
| 3. Photos | Photos section | Phase 2 evidence |
| 4. Pick/create a circuit | Measurements → circuit picker | Phase 1 `Circuit` |
| 5. Record a reading | Measurements → "Record reading" | `POST .../measurements` |
| 6. Reading is evaluated | Result badge on the reading | `lib/diagnostics/measurementRules.ts`, computed server-side at creation |
| 7. Start an investigation | Diagnosis & safety → "Start investigation" | Phase 3A `DiagnosticSession` |
| 8. Read the safety verdict | Safety banner, above all diagnostic content | Phase 4 `lib/safety/*`, computed on read |
| 9. See what to verify next | "Verify before going further" list | Safety `verifications` |
| 10. Record possible causes | Diagnosis & safety → "Add a possible cause" | `DiagnosticCandidateCause` |
| 11. Link the reading that settles one | Per-cause reading picker | `resolvingMeasurementId` |
| 12. Confirm / rule out | Per-cause buttons | `diagnosticCauseRepository.update` invariants |

### Circuit context — solved in the workflow, not the schema

The Safety Engine derives "circuit under investigation" from the circuits a job's measurements reference; `DiagnosticSession` has no `circuitId` column. Rather than add one, the measurements form keeps a **working circuit** that defaults to the last circuit used on the job and pre-fills every new reading. Attributing readings to a circuit is what lets the safety layer identify one, so the UI states that consequence directly in the field hint.

Trade-off: a session whose readings are unattributed still reports `INSUFFICIENT_INFORMATION`. That is correct behaviour, not a defect — the system genuinely cannot tell which circuit is being worked on.

## Safety integration

The safety banner renders **above** the session and its causes, and before the AI assessment section. A stop condition must be the first thing read, never something found after scrolling past model output.

Three states, styled distinctly: `STOP` (danger, `role="alert"`), `INSUFFICIENT_INFORMATION` (warning), `PROCEED_WITH_PRECAUTIONS` (neutral). The floor state is deliberately **not** styled or worded as an all-clear — it reads "No blocking condition found — standard precautions apply", and the baseline precautions render at every state including that one.

The UI is strictly read-only with respect to safety. It cannot weaken, dismiss, or override a verdict; there is no control that does so and no endpoint that would accept one. Verdict text is rendered from the server's constants, never composed in the browser.

`pass` is labelled **"In range"**, not "OK" or "Safe" — it means the reading fell inside the range the technician supplied, which is a statement about that range. Any reading carrying an expected range displays "range supplied by technician, not a verified standard" beneath it.

## Data flow

```
page.tsx (server)
  withAuthenticatedOrgContext          ← membership verified, RLS context set
    job, evidence, assessments, measurements, circuits, sessions
  → JobWorkspace (client)
      MeasurementsSection  → POST /measurements       → result computed server-side
      DiagnosticsSection   → GET  /diagnostics/[id]   → { session, safety }
```

The safety verdict is computed on every read of the session detail and never stored, so a reading recorded after a previous view cannot leave a stale verdict on screen. Saving a reading calls `router.refresh()`, and any cause mutation re-fetches the session, so the verdict always reflects the current facts.

## Errors

Validation happens twice for different reasons: in the browser for immediate feedback (non-numeric reading, inverted expected range) and on the server as the actual authority. Server rejections are translated into electrician-facing sentences — an invalid unit for a test type explains which combination was refused; a cross-job reading link says so plainly; a second confirmation on a session that already has one explains that the first must be ruled out first. No stack traces or database errors reach the user.

## Database

Migrations 15–18 were applied during this phase, and the resulting schema was verified by querying it rather than trusting the migration output:

| Object | Verified |
|---|---|
| `circuits`, `measurements`, `diagnostic_sessions`, `diagnostic_candidate_causes` | exist; RLS **enabled and forced**; 1 policy each |
| `measurement_test_type` (8), `measurement_result` (4), `diagnostic_session_status` (4), `diagnostic_cause_status` (3) | enum labels correct |
| Foreign keys | circuits 2, measurements 5, sessions 3, causes 4 |
| `app_user` grants | select/insert/update/delete on all four |

`prisma migrate status` reports **"Database schema is up to date"**. Application schema and live database now agree.

### One infrastructure change

`lib/db/tenantContext.ts` now passes `{ maxWait: 10_000, timeout: 20_000 }` to `prisma.$transaction`. Prisma's defaults (2s / 5s) are sized for a short write against a local database; the job workspace legitimately performs six tenant-scoped reads, which exceeded 5s against pooled remote Postgres on round-trip latency alone, and Prisma then refused the commit. This raises a ceiling — it does not change what the transaction does, and `set_config` remains transaction-local either way. Kept modest rather than generous, because a long transaction pins a Supavisor connection for its duration.

## Known limitations

1. ~~**`STOP` still has no active producer.**~~ **Resolved in Phase 7C.** Every threshold-free *measurement* rule still tops out at `INSUFFICIENT_INFORMATION` — a magnitude-based `STOP` still needs a verified electrical standard nobody has cited, and none has been added. But `STOP` is no longer unreachable: three AI-assessment hazard categories (`arc_fault_suspected`, `water_ingress_energized`, `thermal_damage_scorching`) now drive it through a deterministic rule, escalation-only, once a technician has a completed assessment flagging one. See `docs/architecture/safety.md` §4/§9 for the full mapping and the boundary chain from AI finding to verdict.
2. **Sessions with unattributed readings report `INSUFFICIENT_INFORMATION`.** Mitigated by the working-circuit default, not eliminated.
3. **Circuits are managed only from within the measurements form.** There is no separate circuit-management screen; a circuit can be created and selected there but not renamed or deleted from the UI (the API supports update).
4. **No AI reads measurements or diagnostics.** The existing photo-based assessment is untouched and still operates only on evidence.
5. **E2E latency.** Against remote Postgres a page render takes several seconds, so `tests/e2e/electrician-workflow.spec.ts` raises its assertion budget to 30s. The full-journey specs are latency-sensitive and can need a retry.

## Phase 6 boundary

Phase 5 deliberately implements no AI. What it does provide is the structured context Phase 6 will need, already assembled server-side and reachable in one read:

- **circuit** — `circuit_under_investigation` fact, or an explicit `Unknown` with a reason
- **measurements** — typed readings with unit, expected range, and criterion source
- **evaluations** — `Measurement.result`, computed deterministically
- **diagnostic state** — session status plus every candidate cause and its status
- **causes/evidence** — statements, recommended next tests, linked resolving measurements
- **safety state** — verdict, fired rule ids, findings, verifications, unknown facts, ruleset version
- **next action** — the `verifications` list

The boundary that must not move: **facts come only from persisted rows, never from model output**, and safety is computed independently rather than as a filter over generated text. See `docs/architecture/safety.md` §9.
