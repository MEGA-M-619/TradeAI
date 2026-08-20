# TradeAI — Diagnostic Engine (Phase 3A)

## What this is, and what it is not

A **`DiagnosticSession`** is a structured troubleshooting thread for a job: a symptom statement, a status, and a set of technician-authored **`DiagnosticCandidateCause`** hypotheses. The intended workflow: symptom → observations → measurements → candidate causes → recommended next test → updated assessment → diagnosis.

This is **not** a version of, an extension of, or a replacement for `AiAssessment` (the existing Phase 3 — original numbering — vision-assisted assessment pipeline in `lib/ai/`). The two are deliberately independent tables with no FK or citation relationship between them, and nothing in `lib/ai/executor.ts` reads or writes anything described in this document. This separation is a real, unresolved architectural question rather than a settled decision — see "Left for later phases" below.

Every table and field introduced in Phase 3A is **DETERMINISTIC**, in the same sense the Phase-3-original tables use that word: application-owned, testable, a bug if wrong. There is no model-authored content anywhere in this phase — every `DiagnosticCandidateCause` is entered by a technician, and every state transition is either an explicit technician action or a deterministic rule enforced in application code.

## Data model

```
DiagnosticSession
  symptom: string
  status: open | investigating | diagnosed | abandoned

DiagnosticCandidateCause  (belongs to a DiagnosticSession)
  statement: string
  status: candidate | confirmed | ruled_out
  recommendedNextTest: string | null
  resolvingMeasurementId: Measurement.id | null
```

A job may have more than one `DiagnosticSession` (a technician may find a second, unrelated issue mid-visit). "Observations" and "measurements" are not new tables — they are the existing `Evidence` (photo + caption) and `Measurement` (Phase 1/2) rows for the same job, surfaced alongside a session rather than duplicated into it.

## How the pipeline maps onto this

| Pipeline step | Backed by |
|---|---|
| symptom | `DiagnosticSession.symptom` |
| observations | existing `Evidence` and `Measurement.note` for the job |
| measurements | existing `Measurement` rows; `Measurement.result` is computed by `lib/diagnostics/measurementRules.ts` |
| candidate causes | `DiagnosticCandidateCause` rows, technician-authored |
| recommended next test | `DiagnosticCandidateCause.recommendedNextTest` |
| updated assessment | the session's/cause's own state, recomputed as new measurements or verdicts come in — not a new `AiAssessment` version |
| diagnosis | a `DiagnosticCandidateCause` reaching `status: confirmed` |

## Deterministic invariants (enforced in `lib/db/repositories/diagnosticCauseRepository.ts`, not the database)

1. **At most one `confirmed` cause per session.** `diagnosticCauseRepository.update` checks for an existing confirmed cause (excluding the one being updated) before allowing a second confirmation, throwing `DiagnosticCauseConflictError` if one exists.
2. **Confirming a cause moves its session to `diagnosed`.** Happens in the same call, inside the caller's transaction.
3. **`status` can only ever be set by `update`, never by `create`.** `DiagnosticCandidateCauseCreateInput` has no `status` field — the column defaults to `candidate` at the database level — so invariant 1 has exactly one code path to guard.
4. **Un-confirming does not revert the session.** Changing a cause's status away from `confirmed` leaves its session at `diagnosed`. This is a deliberate, documented scope decision for Phase 3A, not an oversight — reverting is a separate design question (does the session go back to `investigating`? Is that even correct if a technician meant to keep it closed?) left open rather than answered by assumption.
5. **`resolvingMeasurementId` is informational, not causal.** Linking a `Measurement` to a cause never by itself changes that cause's `status`. Whether a specific measurement's pass/fail *confirms* or *rules out* a *specific* candidate cause is domain judgment this codebase has no verified authority to automate — the same reasoning that keeps `lib/diagnostics/measurementRules.ts` free of invented electrical-standard thresholds. A technician still makes the confirm/rule-out call themselves, informed by the linked measurement's computed `result`.

## Left for later phases

**Phase 3B** (implemented): API routes (`app/api/orgs/[orgId]/jobs/[jobId]/diagnostics/...`) exposing the repositories built in this phase, and the measurement-creation route now calls `evaluateMeasurementResult` synchronously inside the same transaction that writes the row — so `Measurement.result` is populated at creation time rather than left null.

**Phase 4 — Safety Engine**: Phase 3A emits no safety warnings, even where a diagnostic session's state might obviously warrant one. Relocating/extending `lib/ai/safetyRules.ts` and deciding whether it should react to diagnostic-session state at all is Phase 4's job.

**Phase 6 — AI Layer**: no LLM involvement anywhere in this phase. `DiagnosticCandidateCause` has no `origin`/`source` column distinguishing a technician-authored cause from a model-authored one — Phase 6 would add one as a small additive migration if AI-authored causes are introduced, not before. The open question of whether AI-assisted diagnosis should generalize the existing `AiAssessment` pipeline or extend this one is **not resolved** by Phase 3A choosing independent tables — if anything, that choice is a data point toward "parallel system" that Phase 6 planning should weigh explicitly, not a decision already made on its behalf.

## Where to look

| Concern | File |
|---|---|
| Schema | `prisma/schema.prisma` (`DiagnosticSession`, `DiagnosticCandidateCause`, and their enums) |
| Migrations | `prisma/migrations/20260819000017_diagnostic_sessions/`, `.../20260819000018_diagnostic_sessions_rls/` |
| Repositories + invariants | `lib/db/repositories/diagnosticSessionRepository.ts`, `lib/db/repositories/diagnosticCauseRepository.ts` |
| Validation | `lib/validation/diagnostics.ts` |
| Deterministic measurement evaluation | `lib/diagnostics/measurementRules.ts` |
| Unit tests | `tests/unit/diagnostics.test.ts` |
| Isolation + invariant tests | `tests/security/diagnostics-isolation.test.ts` |
