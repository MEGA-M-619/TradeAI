# TradeAI — Safety Engine (Phase 4–7)

This describes the Safety Engine **as implemented in Phases 4A–4F and 7A–7E**, not as originally proposed. Where the implementation diverges from the plan, the implementation is the source of truth and the divergence is called out.

Phase 4 shipped the state model, the fact/uncertainty model, five threshold-free measurement rules, the evaluator, the fact builder, and a read-side integration into the diagnostics session GET. Phase 7 extended the same engine — no new subsystem — with standards-citation scaffolding (7A), a deterministic fact derived from AI-assessment findings (7B), eight rules that map that fact's categories onto the lattice (7C), and four fixes to the legacy AI-assessment safety path that predates the Safety Engine (7D–7E). Every invariant below that Phase 4 established (max-only aggregation, no downgrade operation, `Unknown` never defaults, no electrical-standard threshold without a verified citation) still holds; Phase 7 is additive to it, not an exception from it.

## 1. Purpose and scope

The Diagnostic Engine answers *"what might be wrong?"* The Safety Engine answers a different and narrower question: **"what may safely be done given what we currently know?"**

It is deterministic, pure, and independent of any language model. It reads facts the database establishes, applies a closed set of rules, and returns one verdict plus the specific verifications that would resolve it. It reaches no conclusion about the physical installation, because it cannot inspect one.

**Scope of Phase 4:** the state model, the fact/uncertainty model, the rule registry, the evaluator, the fact builder, and a read-side integration into the diagnostics session GET. Nothing else.

**Scope of Phase 7:** a fourth fact (`ai_hazard_categories`) and eight rules that let AI-assessment output influence this verdict, **escalation-only**; standards-citation scaffolding (unused); four fixes to the pre-existing AI-assessment safety path (`lib/ai/safetyRules.ts`, `lib/ai/executor.ts`) so it behaves consistently with the guarantees this document makes. No electrical-standard threshold, no new state, no downgrade path, no persisted verdict.

## 2. Safety state model

```
STOP  >  INSUFFICIENT_INFORMATION  >  PROCEED_WITH_PRECAUTIONS
```

| State | Meaning |
|---|---|
| `STOP` | A rule positively identified a hazard condition. Do not proceed. |
| `INSUFFICIENT_INFORMATION` | A required fact is unknown, or readings contradict each other. Named verification must happen first. |
| `PROCEED_WITH_PRECAUTIONS` | **Floor.** No active rule escalated. Baseline precautions still apply. |

**There is no `SAFE` / `ALL_CLEAR` / permissive state, and adding one would be a regression.** TradeAI cannot inspect an installation, so it has no basis to certify one. This matches the invariant already enforced in `lib/validation/assessment.ts` (*"no `isSafe`/`isCodeCompliant` boolean exists — the model has nowhere to declare something safe or compliant"*) and the standing instruction in `lib/ai/tool.ts` never to imply anything is safe to touch. The floor is a statement about **what the system knows**, not about the installation.

**Aggregation is max-only.** `aggregateSafetyStates` folds findings with `maxState`, which is commutative, associative, and idempotent — all asserted by property tests over every pair, triple, and sequence up to length 3. Rule ordering therefore cannot change a verdict.

**There is no downgrade operation, and the module could not express one.** `evaluate` computes a fresh verdict from facts and accepts no prior verdict as input, so no caller — not the diagnostic engine, not a route, not a future model — has anything to call to talk the system down from `STOP`. A situation leaves a restrictive state only when the underlying **facts** change and a new evaluation is computed from scratch. A test scans the source for `minState`, `Math.min`, and downgrade-shaped identifiers; another asserts no export name matches a minimising pattern.

Type-level reinforcement: a rule's `RuleOutcome.state` is `Exclude<SafetyState, "PROCEED_WITH_PRECAUTIONS">`, so a rule has no vocabulary for "this is fine". A runtime backstop (`InvalidRuleOutcomeError`) rejects a floor-state outcome that crossed a type boundary.

## 3. The fact model: `Known<T> | Unknown`

```ts
type Known<T> = { known: true; value: T };
type Unknown  = { known: false; reason: UnknownReason; detail: string };
type Fact<T>  = Known<T> | Unknown;
```

`UnknownReason` is closed: `not_recorded`, `ambiguous`, `depends_on_unknown_fact` — the last being how uncertainty **propagates** rather than getting absorbed.

**Why Unknown must never silently become a value.** In JavaScript the natural stand-ins for "we don't have this" — `null`, `undefined`, `false`, `0`, `""` — are all indistinguishable from real data at a glance, and defaulting one of them in is how an unknown quietly becomes an assumption. The module makes that impossible:

- **No defaulting accessor exists.** There is no `unwrapOr`, `getOrDefault`, `valueOr`, or `orElse`. The only ways to read a value are narrowing with `isKnown` or calling `unwrapKnown`, which throws. A test scans export names to keep it that way.
- **`known()` rejects `null`, `undefined`, and blank strings** — but the guard is explicit, never a truthiness test, so `known(false)` and `known(0)` remain legitimate facts distinguishable from Unknown. A test asserts precisely this.
- **`Known([])` and `Unknown` are different facts.** "We looked and there is nothing" is an answer; "we could not establish what is there" is not. Both may lead a rule to escalate, but collapsing them would destroy the input the rules need.

Facts are plain JSON-serializable data — no classes, no symbol discriminants — so an evaluation's basis round-trips through an API response unchanged.

### Fact vocabulary (closed, 4 keys)

| Key | Consumed by |
|---|---|
| `circuit_under_investigation` | the unidentified-circuit rule |
| `measurements_on_job` | contradiction / inconclusive / unevaluated rules |
| `measurements_on_circuit` | the no-measurement-on-this-circuit rule |
| `ai_hazard_categories` (Phase 7B) | the eight AI hazard rules (§4) |

`ai_hazard_categories` is `Known([])`, not `Unknown`, when the job has no completed AI assessment — absence of an assessment is itself established by looking, not a gap in what could be read. Treating it as `Unknown` would escalate every measurement-only job to `INSUFFICIENT_INFORMATION`, since a required `Unknown` fact escalates by design (§4). `Unknown` on this key is reserved for the existing fail-closed path: an unreadable diagnostic session (§7).

## 4. Rule architecture

A rule is **structured data carrying a pure predicate** — not a generic DSL (which could not express "two readings disagree") and not a bare function (which would lose the metadata that makes the registry auditable).

```ts
type SafetyRule = {
  id: SafetyRuleId;                 // closed union
  requires: readonly FactKey[];     // drives automatic unknown-escalation
  sourceStatus: RuleSourceStatus;
  whenUnknown: { message: string; verify: string };
  evaluate: (facts: SafetyFacts) => RuleOutcome | null;
};
```

**Missing facts escalate through exactly one code path.** `applySafetyRule` filters `requires` for unknowns *before* calling `evaluate`, so a rule physically cannot abstain because its input was absent. That is the executable form of *unknown ≠ safe*. A test proves the predicate is never invoked in that case, and every rule × every required fact is covered.

A finding carries `ruleId`, `state`, constant `message` and `verify` text, and a `basis` of `{ factsUsed, measurementIds (sorted), criterionSource, unknownReason }`. **All message text is a module constant** — never generated, never model-authored.

### Active measurement rules (5)

| Rule ID | Fires when |
|---|---|
| `circuit_not_uniquely_identified` | the circuit fact is Unknown (its `evaluate` always returns `null`; the rule *is* its unknown case) |
| `no_measurement_on_circuit` | `Known([])` — we looked and nothing was recorded |
| `contradictory_measurement_results` | same circuit + test type carry both `pass` and `fail` |
| `inconclusive_measurement` | any result is `inconclusive` |
| `unevaluated_measurement` | any result is `not_applicable` or `null` |

### Active AI hazard rules (8, Phase 7C)

`lib/safety/rules/aiHazardCategories.ts` declares one rule per `SafetyCategory` — the closed, eight-value vocabulary the AI assessment pipeline has selected from since Phase 3 (`lib/ai/safetyRules.ts`). Each rule requires `ai_hazard_categories` and fires when its category appears in that fact's value; the eight rule ids are `ai_hazard_<category>`.

These are the **first and only rules whose trigger originates outside the measurement data**, and the only current producers of `STOP` — proven end-to-end (persisted AI finding → fact → rule → verdict) by the live-DB test `Safety 8: a persisted arc-fault finding produces STOP through the real stack` in `tests/security/safety-facts-isolation.test.ts`.

| Category | State | Why |
|---|---|---|
| `arc_fault_suspected` | `STOP` | Acute hazard; already worded as stop-work in the legacy path. |
| `water_ingress_energized` | `STOP` | Acute hazard. |
| `thermal_damage_scorching` | `STOP` | Acute hazard. |
| `backfed_or_double_lugged_neutral` | `INSUFFICIENT_INFORMATION` | Names a specific verification a licensed electrician must perform; the system cannot judge it alone. |
| `missing_bonding_or_grounding` | `INSUFFICIENT_INFORMATION` | Same. |
| `aluminium_branch_conductors` | `INSUFFICIENT_INFORMATION` | Same. |
| `recalled_panel_brand` | `INSUFFICIENT_INFORMATION` | Same. |
| `knob_and_tube_or_asbestos_era` | `INSUFFICIENT_INFORMATION` | Same. |

The mapping is exhaustive over `SafetyCategory` (`Record<SafetyCategory, AiHazardSpec>`), so adding a category to the Zod enum without a mapping here is a compile error, not a silently unmapped hazard — the same guarantee `CATEGORY_RULES` already gives the legacy path. There is no intermediate tier between the two states used here; the lattice has only three levels, and adding a fourth would mean revisiting every existing rule's ordinal position (§12).

**These rules carry no threshold and need none.** "Scorching was noted" and "the panel brand may be recalled" are observational, not magnitude comparisons — exactly the property that lets them ship while `energized_conductor_indication` (§4, "Deferred rules") stays deferred. `sourceStatus: "no_threshold_required"` on all eight.

**Escalation-only is enforced at four independent layers**, not by review discipline:
1. **Type** — `RuleOutcome.state` is `EscalatedState`, which excludes the floor; these rules have no vocabulary for "this is fine".
2. **Runtime** — `InvalidRuleOutcomeError` rejects a floor-state outcome that crossed a type boundary.
3. **Aggregation** — `evaluateSafety` combines findings with `maxState`, a max-only fold (§2); a category can raise the verdict or leave it alone, never lower it.
4. **Data path** — the AI model contributes only a *category*, persisted and re-validated against the closed vocabulary (§9); the category-to-state mapping lives in this file's table, in code, fixed at every evaluation. The model never reaches a state, a message, or the mapping itself.

### Deferred rules (1, inactive)

`energized_conductor_indication` — the most valuable rule the engine lacks and the only foreseeable producer of `STOP` from measurement data. It cannot be written without knowing what magnitude counts as energized, which requires a verified standard. It contains **no numbers, no citations, no standard names**; its `evaluate` throws; and three mechanisms stop it activating (module-load check, registry test, source scan).

## 5. Standards policy

**No NEC, IEC, BS 7671, Lebanese, manufacturer, or any other electrical-standard threshold appears anywhere in this engine, and none may be added without a verified source.** No jurisdictional compliance is claimed. Rule messages describe what the system knows; they never rule on compliance.

The guard is structural, enforced three ways:

1. `applySafetyRule`'s registry is validated at **module load** — a rule marked `requires_verified_source` in `ACTIVE_RULES` throws at import.
2. A **unit test** asserts the same, and runs unconditionally in CI.
3. A **source scan** asserts no rule file contains `NEC`/`IEC`/`BS 7671`/`NFPA` or compares `.value` against a literal.

**When a verified source is obtained**, the rule must identify **standard, edition, and clause** before activation. As of Phase 7A this is an **enforced type, not just policy**.

`SafetyRule` carries an optional `source?: { standard, edition, clause }` (`lib/safety/rules/types.ts`), all three fields required and non-blank when present. `RuleSourceStatus` gained a third value, `"verified"`, alongside the two Phase 4 shipped (`no_threshold_required`, `requires_verified_source`). `ruleSourceProblems(rule)` enforces the relationship as a **biconditional** — `"verified"` requires a complete `source`, and a `source` requires `"verified"` — so a rule cannot look cited without the status that makes the guard notice it, and cannot claim the status without a real citation. This is checked three ways, matching the pattern already used for the standards guard: at **module load** over `ALL_RULES` (throws on import), by a **unit test**, and — because a half-citation reads as authoritative while being unverifiable — there is deliberately no way to attach `source` without `"verified"` or vice versa.

**No rule uses `"verified"` today, and none should until a real standard is cited.** Phase 7A built the scaffolding *before* any citation exists specifically so that, when one is obtained, expressing it is a one-field addition to an existing rule rather than a schema change made under time pressure. `VERIFIED_CRITERION_SOURCES` remains deliberately empty, `MeasurementCriterion` still has only `technician_supplied` and `none` variants, and `energized_conductor_indication` (§4) stays deferred — Phase 7 did not invent, approximate, or partially cite any NEC, IEC, BS 7671, Lebanese, or manufacturer threshold. The scaffolding changes what is *expressible*; it does not change what is *known*.

## 6. Measurement boundary

`lib/diagnostics/measurementRules.ts` answers *"is this reading inside the range the technician typed in?"* — numeric conformance. The Safety Engine answers *"what may be done?"* — permission. **`Measurement.result` is an input fact, never a verdict.**

| `result` | Contribution |
|---|---|
| `pass` | **Does not mean safe.** Never de-escalates. Consulted by exactly one rule, and only to notice it contradicts a `fail`. |
| `fail` | **Does not automatically mean `STOP`.** One quantity fell outside a technician-supplied expectation; whether that is a hazard is a rule's job, and no active rule concludes it. |
| `inconclusive` | Contributes uncertainty → escalates. |
| `not_applicable` / `null` | A number with no criterion, or never evaluated → escalates. Never "fine". |

**Technician-supplied ranges are unverified criteria.** `expectedMin`/`expectedMax` arrive in the request body, so a caller can post any range and manufacture a `pass`. Every finding records `criterionSource`, so a verdict resting on one is visibly labelled.

> **Design decision worth knowing.** A fabricated range *can* silence the rules. What it buys is **silence, not certification** — the floor state carries mandatory precautions and asserts nothing, and the engine has no permissive verdict to reach. The stricter alternative (treating any technician-supplied criterion as itself insufficient) was rejected because every criterion in the system currently is technician-supplied, so the rule would fire on every measurement ever recorded and stop distinguishing anything. If you want the stricter reading, it is a one-predicate change in `unevaluatedMeasurement.ts`.

**Contradictions escalate; they are never resolved.** The engine does not take the most recent reading, the most favourable, or an average — all three would be the engine inventing a fact it does not have. A test asserts a newer `pass` does not override an older `fail`.

## 7. FactBuilder

`buildSafetyFacts(tx, orgId, jobId, sessionId)` is the **only** module in `lib/safety` that touches the database.

- **Repository-only access.** Reads through `diagnosticSessionRepository`, `jobRepository`, `measurementRepository`, `circuitRepository`. No `prisma.<model>`, no raw SQL — asserted by a source scan.
- **No request input becomes a fact.** Arguments come from verified route params inside an org-scoped transaction. There is no parameter through which a state, severity, rule id, or verification item could be supplied. This follows the convention stated in `lib/validation/evidence.ts`: accepting such values from the client *"would hand the caller the authorization decision."*
- **No AI/model output.** A fact is something the database establishes; a model proposal is not a fact.
- **Fail-closed.** If the session cannot be read — wrong job, wrong org, forged or missing context — **every fact returns `Unknown`, not empty**, and the verdict escalates. An unreadable session must never evaluate like a session with nothing wrong with it.
- **Deterministic ordering.** Measurements sorted by `(recordedAt, measurementId)`. The repository orders by `recordedAt` alone, and Postgres may return equal-key rows in any order, so the id breaks the tie.

**Circuit derivation.** `DiagnosticSession` has no `circuitId` column, so the circuit is derived from what the job's measurements reference: none → `not_recorded`; several → `ambiguous`; one that is not readable for the job's customer → `not_recorded`. In each case `measurements_on_circuit` propagates as `depends_on_unknown_fact`.

**Scope note:** `measurements_on_circuit` is filtered from *this job's* measurements, not every job on that circuit. Readings from other visits are job-memory context, not facts about the situation being evaluated.

## 8. Diagnostic integration

`GET /api/orgs/[orgId]/jobs/[jobId]/diagnostics/[sessionId]` returns `{ session, safety }`. The `session` field is unchanged; `safety` is additive.

**Computed on read, never stored.** The verdict is recomputed from current facts on every request, so a measurement recorded after an earlier read cannot leave a stale verdict on screen.

**Strictly read-only.** `buildSafetyFacts` only reads and `evaluateSafety` is pure, so nothing here touches `DiagnosticSession` or `DiagnosticCandidateCause`. **Safety never confirms or rules out a cause** — that preserves the Phase 3A invariant that `diagnosticCauseRepository.update` is the sole writer of cause status, and keeps `resolvingMeasurementId` informational. Whether a reading confirms a *specific* cause is domain judgement this codebase has no verified authority to automate.

Dependency runs one way: safety reads diagnostic state; diagnostics never reads a safety verdict.

## 9. AI boundary

**The governing rule: facts come only from deterministic persisted rows — never from model output.** A model may propose a *cause*, or flag a *hazard category* from a closed vocabulary; neither is itself a fact. There is no code path by which raw model text reaches `SafetyFacts` — only a validated, persisted, re-filtered category can, and only through the chain below. That is what structurally prevents a hallucination from becoming a safety instruction.

| A model may | A model may never |
|---|---|
| Interpret a symptom into candidate causes (proposals) | Produce a `SafetyState`, severity, message, or verification item |
| Select a hazard category from the closed `SafetyCategory` vocabulary, on a finding | Write directly to `SafetyFacts`, or supply anything but a category |
| Suggest next tests as proposals | Post-process, re-word, or re-render a verdict |
| Explain or summarise existing findings | Lower, clear, or suppress any state |
| Raise a hazard flag (escalate, via §4's AI hazard rules) | Bypass persistence — no live model output reaches a verdict directly |

**Why parallel computation rather than an LLM pipeline.** The intuitive design — model generates, safety filters the output — is the weaker one. A filter over generated prose still lets the model's framing through, and sanitising prose fails silently: you cannot tell by inspection whether a reassuring sentence survived. Computing safety **independently from deterministic facts** and rendering it *alongside* model content, from constant text, removes the failure mode entirely. The verdict is never downstream of the model's prose, so there is nothing for the model to reframe. Phase 7 does not weaken this: the model still never composes a verdict, a message, or a state — it only ever selects a category from a fixed list, and every downstream step is deterministic code.

**Escalation-only asymmetry — realized, not merely reserved.** Phase 4 stated this as a design constraint for a future contribution that did not yet exist. Phase 7 is that contribution, and the constraint held: because aggregation is `max` (§2), an AI-sourced category is mathematically incapable of lowering a verdict. This is a property of the fold, not reviewer discipline — see §4's four-layer enforcement.

### The full boundary chain (Phase 7B/7C)

```
AI vision model proposes a finding
  -> schema-validated against the closed SafetyCategory vocabulary, persisted
     as an AiAssessmentFinding row (lib/ai/executor.ts)
       -> a technician may later attach a TechnicianVerdict rejecting it
          (a deterministic human act)
            -> factBuilder.loadAiHazardCategories reads the *latest complete*
               assessment for the job, drops rejected findings, re-validates
               every category against SafetyCategory again on the way out
                 -> ai_hazard_categories, a SafetyFact -- Known([]) when there
                    is no completed assessment, never Unknown for that reason
                      -> the eight AI hazard rules (§4) map category to state,
                         fixed in code, the same mapping every time
                           -> evaluateSafety folds every finding with max
                             -> SafetyState, rendered from constant text
```

Every arrow after "proposes a finding" is deterministic code with no model call in it. The AI advisor described in `docs/architecture/ai-advisor.md` sits entirely outside this chain — it reasons over the *result* of this chain (the safety verdict is part of its read-only context) but has no field, endpoint, or code path through which it could write to `SafetyFacts`, a `SafetyState`, or an `AiAssessmentFinding`. Two separate AI features (vision assessment, diagnostic advisor) share the same rule: neither can be the chain's writer, only its input at one validated step or its reader at the end.

### Legacy AI-assessment path — four fixes (Phase 7D–7E)

These fixed defects in `lib/ai/safetyRules.ts` / `lib/ai/executor.ts` / `lib/db/repositories/assessmentRepository.ts` / `components/jobs/AssessmentSection.tsx` found during the Phase 4 audit — the pre-existing eight-category, three-severity AI-assessment safety path that predates this engine and is a **separate mechanism** from the SafetyState lattice (it writes `AiAssessmentSafetyWarning` rows with `SafetySeverity`, not `SafetyFacts`):

- **Failed runs now persist baseline warnings (7E).** `MarkFailedInput.safetyWarnings` is required; the executor's catch block calls `applySafetyRules([])` — an empty findings list, so a category warning (`category_*`) is structurally unreachable, not merely absent by convention. A failed model call is never treated as evidence of a hazard: `applySafetyRules([])` returns exactly the three constant baseline advisories, proven at three layers — the type (`safetyWarnings` required, no optional-and-forgotten path), a unit test asserting the empty-input call yields exactly `BASELINE_WARNINGS` and no `category_*` id for any category, and a live-DB executor test.
- **`insufficient_evidence` warnings now render.** The three baseline warnings were always persisted on that path; `AssessmentSection.tsx` gated them behind `status === "complete"` and never showed them. The warnings block is hoisted above the status branches so it renders for `complete`, `insufficient_evidence`, and `failed` alike.
- **`SafetySeverity`/`SafetyWarning` are canonical types, not a hand-copied redeclaration.** `AssessmentSection.tsx` imports both as types from `lib/ai/safetyRules` instead of a duplicate local declaration that could silently drift from the Prisma enum.
- **Warning order is deterministic.** `getFullById` now orders `severity desc, ruleId asc`. Postgres enum comparison follows declaration order (`advisory, mandatory, stop_work` in `schema.prisma`), so `desc` puts `stop_work` first — fixing both the non-determinism and the previous "advisories render before the stop-work banner" defect.

**One gap in the legacy path is intentionally still open.** A `timeout` failure is written by the SQL reaper (`reap_stuck_ai_assessments()`), not by `lib/ai/executor.ts`'s catch block, so the 7E fix does not reach it — a timed-out run still persists no baseline warnings. This is a known, named limitation (§12), not an oversight: closing it means giving the reaper's SQL the same warning-construction responsibility the executor has, which is a larger, separately-reviewable change.

## 10. Persistence

**No safety verdict table exists, and none should be added yet.**

A verdict is a pure function of already-persisted facts, so it is derived data and fully reproducible. Storing it introduces the failure mode that matters most here: **a stale stored verdict is itself a hazard** — a persisted `PROCEED_WITH_PRECAUTIONS` could be shown after a new measurement should have escalated it. A stored verdict also misrepresents history once the rule set changes.

`rulesetVersion` (currently `2026-08-19.1`) is returned on every evaluation from day one, so an audit snapshot added later is meaningful without a data migration. The right moment to persist is when a verdict is **presented to a human as part of a durable artifact** — which is exactly what `ai_assessment_safety_warning` already does for assessment runs. No such artifact exists for diagnostics yet.

## 11. Security model

- **Tenant isolation is inherited, not reinvented:** repository scoping (`organizationId` in every `where`) plus RLS with `is_member_of()` re-derivation at the SQL layer.
- **No safety input schema exists.** No endpoint accepts a safety state, severity, rule id, or override — absence-as-enforcement, the same way `isSafe` is kept unreachable.
- **Fail-closed everywhere.** Forged org context, missing context, or a session belonging to another job all yield all-`Unknown` facts and an escalated verdict — never a leak, never a clean-looking result.
- **Crafted-range manipulation is contained** by the reasoning in §6.
- **Known enforcement gap:** ESLint's tenant-table rule only matches a literal `prisma.` identifier, so it would *not* catch `tx.<model>` written directly inside `lib/safety`. `factBuilder` calls repositories only, and a unit test scans its source for direct model access — but that is a test, not a lint rule.

## 12. Current limitations

Stated plainly, because a safety subsystem that oversells itself is worse than one that doesn't exist.

1. ~~**`STOP` has no active producer.**~~ **Resolved in Phase 7C.** Every threshold-free *measurement* rule still tops out at `INSUFFICIENT_INFORMATION` — that part of the original observation stands, and a magnitude-based `STOP` still needs a verified standard nobody has cited. But `STOP` now has three real producers: the AI hazard rules for `arc_fault_suspected`, `water_ingress_energized`, and `thermal_damage_scorching` (§4, §9). This is proven end-to-end against the live database, not just by injected-rule unit tests — `Safety 8` in `tests/security/safety-facts-isolation.test.ts` persists a real `AiAssessmentFinding` carrying `arc_fault_suspected` and reads `STOP` back out through `buildSafetyFacts` → `evaluateSafety`, the same path a real request takes.
2. **Many sessions will report `INSUFFICIENT_INFORMATION`** because no circuit is identifiable — nothing in the UI or API currently prompts a technician to attach a circuit to a measurement, and `DiagnosticSession` has no circuit column. The engine's value is the specific `verifications` list, not the state label; if that list is vague the feature fails regardless of being correct.
3. ~~**Live Supabase/RLS tests are gated.**~~ **Resolved in Phase 5:** the security suite was executed against the live database for the first time. `tests/security/safety-facts-isolation.test.ts` passed in full, so the RLS layer protecting `factBuilder` is now empirically verified, not merely assumed. (Four tests in the unrelated `assessment-executor.test.ts` fail non-deterministically on connection-pool exhaustion against the remote database — an infrastructure limit, not a logic fault.)
4. ~~**The E2E spec does not execute here.**~~ **Resolved in Phase 5:** `tests/e2e/diagnostics-flow.spec.ts` now runs and passes, and `tests/e2e/electrician-workflow.spec.ts` exercises the safety banner through the browser.
5. **Unattributed readings are grouped together.** Two measurements with no `circuitId` and the same test type are treated as comparable and can trip the contradiction rule. Defensible, but worth confirming it matches intent.
6. **Adding a fourth state later** (e.g. a `CAUTION` tier) means revisiting every rule's ordinal position.

## 13. What this engine does NOT implement

- **No AI-generated safety verdicts.** No model output reaches a state, a message, or a fact.
- **No action gating.** The engine reports; it does not withhold anything from a technician. `recommendedNextTest` is technician-typed free text, so there is no machine-generated action to gate. That becomes real only when actions become machine-generated.
- **No persisted verdict snapshots.** See §10.
- **No electrical-standard thresholds.** See §5.
- ~~**No UI.** Nothing renders the safety block yet; it is API-only.~~ **Superseded by Phase 5:** the job workspace now renders the safety verdict, its verifications and its precautions above all diagnostic content. The UI remains strictly read-only with respect to safety — see `docs/architecture/workflow.md`.
- ~~**No changes to the existing AI safety pipeline.**~~ **Superseded by Phase 7.** `lib/ai/safetyRules.ts`'s eight categories are now *also* re-expressed as Safety Engine rules (§4, §9) — but `applySafetyRules` itself was **not** reduced to an adapter and still runs independently, because the two mechanisms answer different questions with different severities. `lib/ai/safetyRules.ts` still owns `AiAssessmentSafetyWarning` (the `advisory`/`mandatory`/`stop_work` warnings shown on the assessment card); the Safety Engine still owns `SafetyState` (the `STOP` / `INSUFFICIENT_INFORMATION` / `PROCEED_WITH_PRECAUTIONS` banner). Phase 7 connects them at the fact layer (`ai_hazard_categories`) without collapsing either into the other — the `mandatory` severities map onto `INSUFFICIENT_INFORMATION` rather than a new lattice tier, exactly the 1:1-avoidance decision this bullet originally flagged as deferred.
- **Four fixes to the legacy AI-assessment path, landed Phase 7D–7E** — see §9 for detail: failed runs now persist baseline warnings; `insufficient_evidence` warnings now render; `SafetySeverity`/`SafetyWarning` are canonical types, not a triple-declared redeclaration; warning order is deterministic (`severity desc, ruleId asc`).

### Known gaps in the *existing* AI safety path

Surfaced during the Phase 4 audit — **resolved in Phase 7D–7E** (see §9 for how each was fixed):

- ~~A **failed** assessment run emits **zero** safety warnings — not even the three baselines — across every failure category.~~ Resolved (7E), **with one named exception below**.
- ~~The `insufficient_evidence` path persists three baseline warnings the UI never renders.~~ Resolved (7D).
- ~~`SafetySeverity` is declared three times with no compile-time link.~~ Resolved (7D).
- ~~Warning display order is insertion order with non-deterministic tie-breaking.~~ Resolved (7D).

**Residual gap, intentionally not closed by Phase 7:** a `timeout` failure written by the SQL reaper (`reap_stuck_ai_assessments()`) still emits no baseline warnings — the 7E fix lives in `lib/ai/executor.ts`'s catch block, which the reaper never runs through. This is an accepted, out-of-scope gap, not an oversight; see §9 for why closing it is a separately-reviewable change.

## Where to look

| Concern | File |
|---|---|
| State lattice, precedence, `maxState`, `RULESET_VERSION` | `lib/safety/states.ts` |
| `Known`/`Unknown`, fact vocabulary, measurement projection | `lib/safety/facts.ts` |
| Rule contract, source status/citation scaffolding, criterion summary | `lib/safety/rules/types.ts` |
| Active registry, missing-fact escalation, module-load guards | `lib/safety/rules/index.ts` |
| Individual measurement rules | `lib/safety/rules/<rule>.ts` |
| The eight AI hazard rules (Phase 7C) | `lib/safety/rules/aiHazardCategories.ts` |
| Deferred, standards-dependent rules | `lib/safety/rules/deferred.ts` |
| Evaluator, baseline precautions | `lib/safety/evaluate.ts` |
| Database-backed fact construction, incl. `ai_hazard_categories` (Phase 7B) | `lib/safety/factBuilder.ts` |
| Read-side integration | `app/api/orgs/[orgId]/jobs/[jobId]/diagnostics/[sessionId]/route.ts` |
| Unit tests | `tests/unit/safety{States,Facts,RuleRegistry,Evaluate,FactBuilder}.test.ts`, `tests/unit/safetyAiHazardRules.test.ts` |
| Tenant-isolation + end-to-end `STOP` proof (`Safety 8`) | `tests/security/safety-facts-isolation.test.ts` |
| Deterministic measurement evaluation | `lib/diagnostics/measurementRules.ts` |
| Legacy AI-assessment severity/category path | `lib/ai/safetyRules.ts` |
| Diagnostic engine | `docs/architecture/diagnostics.md` |
| Existing AI assessment path | `docs/architecture/ai-assessment.md` |
| Diagnostic AI advisor (reads the safety verdict, cannot write it) | `docs/architecture/ai-advisor.md` |
