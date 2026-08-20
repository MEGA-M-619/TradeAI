# TradeAI — Diagnostic AI Advisor (Phase 6)

Phase 6 added an AI reasoning layer over the deterministic engines built in Phases 1–5. It adds **no** new source of truth: every fact the model sees was produced by TradeAI itself, and nothing the model returns can change a measurement, a cause, or a safety verdict.

## Architecture

```
persisted rows (RLS-scoped)
  → deterministic engines (measurementRules, factBuilder, evaluateSafety)
    → buildAdvisorContext            authoritative, server-built
      → DiagnosticAdvisorPort        provider-agnostic
        → AnthropicDiagnosticAdvisor forced structured tool output
          → validateAdvisorResponse  schema + grounding + claim checks
            → electrician
```

Every arrow is one-way. There is no path back from model output into persisted state.

| File | Role |
|---|---|
| `lib/ai/advisor/port.ts` | the narrow provider interface + error types |
| `lib/ai/advisor/schema.ts` | context types, Zod response schema, tool-schema projection |
| `lib/ai/advisor/prompt.ts` | system prompt and context serialisation |
| `lib/ai/advisor/anthropicAdvisor.ts` | **the only file importing a vendor SDK** |
| `lib/ai/advisor/fixtureAdvisor.ts` | deterministic stand-in for tests |
| `lib/ai/advisor/context.ts` | authoritative context builder + staleness fingerprint |
| `lib/ai/advisor/validate.ts` | grounding gate |
| `lib/ai/advisor/service.ts` | orchestration; every failure is a value, not a throw |
| `app/api/orgs/[orgId]/jobs/[jobId]/diagnostics/[sessionId]/advice/route.ts` | authenticated endpoint |
| `components/jobs/DiagnosticAdvicePanel.tsx` | in-context UI inside the session |

**Provider:** Anthropic, model id from `TRADEAI_ADVISOR_MODEL`, defaulting to `claude-sonnet-5`. The abstraction is real — a unit test asserts that only `anthropicAdvisor.ts` imports `@anthropic-ai/sdk` — but only one live provider is implemented. A second provider means adding a sibling file; nothing else changes.

This is a **separate port** from `lib/ai/modelPort.ts`. That one is vision-specific (its input requires images) and belongs to the photo-assessment pipeline. Two narrow ports beat one wide abstraction pretending both jobs are the same shape.

## What the AI receives

Job title and reported problem; the identified circuit (or an explicit reason it is unknown); session symptom and status; every measurement with id, test type, value, unit, expected range, **criterion source**, and deterministic evaluation; every candidate cause with id, status, next test, and linked measurement; a **count** of attached photos; and the full safety verdict — state, ruleset version, fired rule ids, findings, verifications, unknown facts, precautions.

**Deliberately excluded:** customer name, address, phone, email; user identities and emails; other jobs; other organizations; storage keys; secrets. Asserted by `Advisor 5` and `Advisor 6` in the security suite.

Photos are counted, not sent. Image reasoning stays in the existing assessment pipeline; the advisor is told photos exist so it can point at them rather than pretend to have seen them.

## Safety boundary

Four independent mechanisms, in order of strength:

1. **Structural — no field exists.** `advisorResponseSchema` has no safety-state, `isSafe`, or `blocked` field. A test enumerates the schema keys to keep it that way. Zod strips anything undescribed, so a model that emits `safetyState` anyway has it discarded before the UI sees it.
2. **Rendering — separate sources.** The safety banner is rendered by `DiagnosticsSection` from the Safety Engine's own output, above the advice panel. Model text never composes it.
3. **Validation — forbidden claims.** Any assertion that something *is safe*, *safe to touch*, *de-energized*, *code compliant*, or *all clear* fails the whole response. Phrased to catch affirmations, not honest negations.
4. **Validation — no progress past STOP.** When the verdict is `STOP`, prose encouraging the technician onward is rejected. The same sentence is permitted when nothing is blocked.

The model is also told plainly in the system prompt that the verdict is not its to make.

## Grounding

Every cited measurement id must exist in the context; every non-null `causeId` must exist in the session. A fabricated reference **discards the entire response** rather than dropping the offending line — a partially-trustworthy answer about electrical work is not worth salvaging, and removing one sentence would leave the rest reading as verified.

Support is qualitative (`well_supported` / `plausible` / `insufficient_evidence`). There is no numeric confidence field, because nothing in the system produces a calibrated probability.

## Security

Authorization uses the same chokepoint as every other route: `withAuthenticatedOrgContext` verifies the session, re-derives membership from the database, and opens an RLS-scoped transaction. A caller supplying another org's session id gets `404` — and **the model is never called**, so the data cannot reach a provider even transiently (`Advisor 4`).

The request body accepts **only** an optional question. No measurement, evaluation, safety state, cause status, org id, or model id may be supplied — so a caller can neither manufacture the facts the model reasons over nor select a costlier model. `ANTHROPIC_API_KEY` is read server-side only and never reaches a bundle.

Prompt injection: all person-written text (problem, symptom, notes, cause statements, the question) is fenced as untrusted data and the system prompt instructs the model to describe rather than obey any instruction inside it. Wording is the mitigation; the controls are structural — forced tool schema, grounding validation, and a safety verdict the model cannot express.

## Failure handling

The advisor is an enhancement, never a dependency. Every failure is a typed outcome:

| Outcome | HTTP | UI |
|---|---|---|
| `not_found` | 404 | "This investigation could not be found." |
| `unavailable` (no key, outage, timeout, rate limit) | 503 | "AI assistance is unavailable right now. Everything else on this page still works." |
| `ungrounded` (malformed or fabricated references) | 502 | "The AI's answer did not match this job's recorded facts, so it was discarded." |

Verified end-to-end: with no API key configured, the panel reports unavailability and the technician can still read the safety verdict, record readings, add causes and confirm them.

## Cost control and staleness

The advisor runs only on an explicit button press — never on render, poll, or keystroke — and a re-entrancy guard prevents a double tap billing twice. Advice carries a `contextFingerprint` of the deterministic state it was produced from; the panel records the state key at request time and labels the answer stale when a reading, cause status, or verdict changes. Stale reasoning is never presented as current.

**No AI state is persisted and no migration was added.** Advice is transient, which sidesteps the risk of a stored answer outliving the facts it was based on.

## Known limitations

1. **No live model call has been made.** `ANTHROPIC_API_KEY` is not configured in this environment, so the Anthropic path is exercised only by typecheck and unit tests; every behavioural test uses `FixtureDiagnosticAdvisor`. Real-world answer quality, latency, and token cost are unmeasured.
2. **One provider implemented.** The abstraction is enforced by test, but portability is unproven until a second provider exists.
3. **No eval harness.** Phase 6 ships grounding and safety enforcement, not a scored quality suite. `tests/eval/` remains the assessment-pipeline harness only.
4. **The forbidden-claim check is regex-based** — it catches the named claim shapes, not every conceivable paraphrase. It is a backstop behind the structural controls, not the primary defence.
5. **No conversation history.** Each request is independent by design; there is no follow-up threading.

## Boundaries respected

- **Phase 7:** extended `lib/safety/*` — see `docs/architecture/safety.md` §9 for the full boundary chain — but not through this advisor. The AI hazard rules Phase 7 added consume a fact built from persisted, validated **vision-assessment** findings (`lib/ai/executor.ts` → `AiAssessmentFinding`); they have no input from this diagnostic advisor at all. `buildAdvisorContext` (this document, "What the AI receives") includes the resulting safety verdict as **read-only context** the advisor reasons over — the same way it reads measurements and causes — but there remains no field, endpoint, or code path by which this advisor's output could reach `SafetyFacts` or a `SafetyState`. The structural controls in "Safety boundary" above (no schema field, separate rendering, forbidden-claims validation) are unchanged by Phase 7.
- **Phase 8:** no local model, no Ollama, no quantization. The port is the only preparation.
- **Phase 9:** no job memory, history, notifications, or exports.
