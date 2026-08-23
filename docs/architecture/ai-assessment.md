# TradeAI — AI/Vision-Assisted Assessment (Phase 3)

Phase 3 scope: a structured, append-only assessment record produced by
sending technician-selected job photographs to Claude, plus the
deterministic scaffolding (citation integrity, safety rules, quotas) that
keeps the model's output from ever being mistaken for a technician's own
diagnosis. This document covers the parts of that design that are a
commitment to users and customers, not just an implementation detail:
what data leaves this application, what it doesn't, and what must be true
before this feature reaches production.

## The one rule everything follows from

**The model produces inferences, never facts.** A licensed electrician,
not the model, is what turns an inference into a diagnosis. Every design
choice below is downstream of that, and it is enforced structurally, not
just by prompting:

- The output schema (`lib/validation/assessment.ts`) has no field for a
  price, a quantity, a safety assurance, or a code-compliance ruling --
  the model has nowhere to put one, however phrased.
- Confidence is `low | medium | high` with mandatory rationale, never a
  number. A percentage next to a hypothesis manufactures a precision the
  model does not have and a technician might reasonably rely on.
- A technician's verdict (`technician_verdict`) is a separate table from
  the model's finding (`ai_assessment_finding`), never an edit to it.
  Confirming or rejecting a hypothesis never rewrites what the model
  actually said -- both survive independently and permanently.

## What is sent to Anthropic, and what never is

| Sent | Never sent |
| --- | --- |
| Image bytes of the technician-selected evidence (up to 8 photos per request) | Customer name, address, phone, or email |
| The job's title | The organization's name |
| The job's problem description (free text the technician or customer provided) | Any user's identity or account information |
| The system prompt and tool schema (`lib/ai/tool.ts`) | Any other job's data |
| | Any evidence the technician did not explicitly select for this request |

This is enforced by construction, not by care at the call site: the
prompt builder (`lib/ai/tool.ts`'s `buildUserContent`) takes a narrow
`jobContext: { title, problemDescription }` type. There is no code path
by which a `Customer` record, an `Organization` record, or a `User`
record could reach it -- the type itself makes that impossible to pass
in, not just discouraged.

**Residual risk that is not solved by any of the above:** a photograph of
a panel or fault can incidentally include things nobody intended to
capture -- a face in the background, mail on a counter, a calendar. That
information exists in the pixels themselves, and no field-level
stripping addresses it. The only real mitigations are (1) the technician
choosing which photos to include per request rather than every photo on
the job being sent automatically, (2) clear in-product disclosure before
a photo is taken or selected, and (3) short retention. This is an
accepted risk, disclosed here rather than presented as solved.

## Retention

- **TradeAI's own storage** (Supabase Storage / Postgres): governed by
  Phase 2's evidence lifecycle, unchanged by Phase 3. Assessment
  metadata (`ai_assessment` and its child tables) is retained
  indefinitely today -- there is no automatic expiry. `rawResponse` on
  `ai_assessment` retains the model's response verbatim for
  provenance/debugging; it is never rendered to end users directly and
  should be included in any future data-retention or right-to-erasure
  process the same way the rest of a job's data is.
- **Anthropic's retention** of the images and text sent in each request
  is governed by Anthropic's own API terms, not by anything in this
  codebase. **Before production traffic**, confirm the applicable
  retention/training-use terms for the account this deploys under, and
  put a zero-retention or equivalent agreement in place if the business
  requires one -- this is a contractual decision, not a code change, and
  is called out explicitly in the pre-launch checklist below because it
  is easy to defer indefinitely otherwise.

## Deliberately deferred at the close of Phase 3

Recorded here so these read as decisions with a known trigger, not as
forgotten work. Both were resolved against the actual repository
configuration at the end of Phase 3 and consciously deferred:

- **Scheduled execution trigger (D1).** There is no deployment target in
  this repository -- no `vercel.json`, `Dockerfile`, `fly.toml`,
  `Procfile`, or git remote, and `.github/workflows/ci.yml` is test-only
  with no deploy job. A scheduled sweep needs a deployed URL to call, so
  wiring one is blocked on choosing a host, not on any code here.
  **Deferred deliberately**, because the functional path does not depend
  on it: the in-process kick handles the normal case, and the
  opportunistic reap that runs inline on every status poll resolves stuck
  assessments for anyone actually waiting on one. What is genuinely
  missing is only the sweep for runs that nobody is polling. See
  pre-launch item 7.

- **Live model validation (D4).** `ANTHROPIC_API_KEY` is not configured,
  so no live model call has ever been made -- every test, including the
  full adversarial executor suite, runs against `FixtureAssessmentModel`.
  That is the correct design for CI, but it means real prompt-injection
  resistance and assessment quality are **unverified**, and the
  evaluation harness in `tests/eval/` has never been executed.
  **Deferred deliberately**, to happen together with the privacy gates
  below rather than piecemeal -- there is little value in validating
  model behaviour against real photographs before the data-handling
  agreement covering those photographs is in place.

## Pre-launch checklist

None of these are implemented by Phase 3 -- they are organizational and
legal steps that must happen before this feature is exposed to real
customer data in production.

1. Zero-retention (or otherwise acceptable) data-handling agreement with
   Anthropic in place and verified for the production account.
2. Privacy policy updated to disclose that job photographs may be
   processed by a third-party AI service.
3. Customer-facing consent language for photography and its processing
   -- the technician is usually the one taking photos inside a customer's
   home, so the disclosure needs to reach the customer, not just the
   technician.
4. Data processing agreement reviewed for every jurisdiction this
   product is sold into.
5. An in-product reminder at the point of photo upload or assessment
   request, so the technician is prompted to think about what's in frame
   before sending it -- see the residual-risk note above.
6. `ANTHROPIC_API_KEY` and `INTERNAL_API_SECRET` provisioned as real
   production secrets, not the placeholder/local values used in
   development (see `.env.example`).
7. A stuck-run reaper trigger actually scheduled (see below) -- the
   mechanism exists and is tested, but nothing runs it automatically yet.

## Architecture summary

### Execution: deployment-agnostic, async, polled

`runQueuedAssessment` (`lib/ai/executor.ts`) is a plain async function
with no framework dependency. It can be invoked three ways, and all three
are safe to run concurrently with each other because of the atomic claim
below:

1. **Best-effort in-process kick**, fired (never awaited) right after the
   create route returns 201. The common case, but not guaranteed to run
   to completion on every host -- if the process is killed the instant
   the response is sent, the row simply stays `queued`.
2. **`POST /api/internal/assessments/run`**, shared-secret-gated
   (`lib/http/internalAuth.ts`), for whatever cron/scheduler the eventual
   host provides. Drains up to 5 queued assessments per call via the
   `list_queued_ai_assessments()` SQL function.
3. **Opportunistic reap** inline in the assessment-status GET route, plus
   **`POST /api/internal/assessments/reap`** for an external scheduler.
   Both call `reap_stuck_ai_assessments()`, which fails a `running` row
   after 5 minutes and a never-claimed `queued` row after 15.

**Nothing in this repository schedules trigger 2 or 3 automatically.**
Wiring an actual cron entry against whatever host this deploys to is a
deployment-configuration step, not a code change -- see pre-launch item 7.

### Why the executor uses the service-role key for one specific read

Every client-facing Storage operation (upload, download, delete -- all of
Phase 2, plus every read the *user* triggers) goes through the user's own
session, deliberately, so Supabase Storage's RLS stays a genuinely
independent second layer. That is unchanged by Phase 3.

The executor is different: it may run with no live user session at all
(trigger 2 or 3 above), so there is no session cookie to build a Storage
client from. `lib/storage/evidenceStorageSystem.ts` uses the service-role
key for exactly one operation -- downloading bytes for a `storageKey`
already read back from `ai_assessment_input`, i.e. already proven, through
the app's own RLS-scoped repository layer, to belong to the exact
org+job+assessment being processed. This is the same category of
"narrow, explicitly-reviewed administrative path" `docs/architecture/
security.md` already carves out for the service-role key (previously used
only by test fixtures); it is a disclosed extension of that carve-out to
a second real use case, not a relaxation of the client-facing guarantee.

### Citation integrity: enforced by the database, not by application code

The model never sees a database id. Images are labeled `E1`..`E8`
(`lib/ai/citations.ts`); the model cites those labels back. The server
resolves a cited ref against `ai_assessment_input` -- the snapshot of
what was actually sent, written only after the bytes were fetched and
their sha256 verified against the evidence row's `clientSha256`.

The database backstops this independently: `ai_assessment_citation` has a
composite foreign key into `(assessment_id, evidence_id)` on
`ai_assessment_input`. A citation can only be inserted if that exact pair
was recorded as sent in that exact run -- a fabricated or cross-run
evidence id fails the insert outright, and the whole persistence
transaction rolls back with it (`assessmentRepository.persistComplete`),
so a response with even one bad citation never becomes a partially
visible assessment. See `tests/security/assessment-executor.test.ts`
("Executor 3") for the live-database proof.

### Server-side payload governance

Image size and count are **not** left to the client. `prepareImageUpload.ts`
downscales in the browser and says outright that it is not a security
control, `evidence.byte_size`/`mime_type` are values the client asserted at
confirm time, and the client holds a signed direct-to-storage upload URL --
so none of those constrain what this application forwards to a third party.

`lib/ai/imagePayload.ts` is that constraint. It runs in the executor's
download loop, against the bytes actually fetched from Storage and
immediately after the sha256 check, enforcing a per-image cap (5 MiB), a
combined cap across the whole request (20 MiB), the 8-image cap
(re-exported from the request schema, never redefined), and a magic-byte
format check that must agree with the mime type recorded on the row. Both
size caps are asserted at module load against Anthropic's documented
ceilings (10 MB base64 per image, 32 MB per request), so raising one past
its ceiling fails immediately rather than in production.

Failures are their own categories -- `payload_too_large` and
`unsupported_media_type` -- so a request this application declined to make
is never reported to the technician as a provider outage.

### What the model says it could not determine

`modelOutputSchema` requires the model to state its own limitations, and
those are persisted (`ai_assessment.limitations`) and shown to the
technician on both terminal success paths, including
`insufficient_evidence`. This is treated as safety information, not a
footnote: a stated limitation is what stops a well-cited finding from being
over-trusted. Like `insufficientReason`, it is model-authored text on an
otherwise deterministic table, and it reaches the database only after
passing the same validation as every other field.

### The deterministic safety layer

`lib/ai/safetyRules.ts` is a pure function with no model involvement.
Three baseline warnings (de-energize and verify; this is not a diagnosis;
code compliance defers to local authority) attach to every assessment
unconditionally. Eight category-triggered rules read the model's
`safetyCategories` selection on each hypothesis (a closed vocabulary the
model selects from, not free text) and emit a warning whose message is a
string constant in the codebase -- never model-generated text. The
function has no code path that removes or downgrades a warning; see the
additive-only property test in `tests/unit/safetyRules.test.ts`.

### Prompt injection

Photographs can contain text -- a panel label, a handwritten note, a sign
someone taped up -- and that text is read by the model like any other
part of the image. `SYSTEM_PROMPT` (`lib/ai/tool.ts`) states explicitly,
before anything else, that image content is untrusted data to describe,
never an instruction to follow. This is backstopped structurally, not
just by the prompt: forced strict tool use (`strict: true` +
`tool_choice: {type:"tool"}`) means injected text cannot change the
*shape* of the output, and citation integrity means it cannot
manufacture supporting evidence that was never sent. The residual risk --
misleading field *content* within an otherwise well-formed, well-cited
response -- is bounded by the technician reviewing every finding against
photos they took themselves, and is one of the axes the opt-in evaluation
harness (`tests/eval/`) is designed to probe once real fixture images
exist.

### Model abstraction

`AssessmentModelPort` (`lib/ai/modelPort.ts`) is deliberately narrow: one
`run()` method, no general-purpose LLM framework. `AnthropicAssessmentModel`
is the real implementation; `FixtureAssessmentModel` replays recorded
payloads for tests and the eval harness. Changing models later means
adding an adapter -- the executor, the safety layer, and persistence
never import a provider SDK.

`STANDARD_MODEL_ID` (`claude-sonnet-5`) is the default for every request.
`ESCALATION_MODEL_ID` (`claude-opus-5`) is used only when the technician
explicitly checks "use the higher-capability model" at request time --
never chosen automatically. The exact model id is persisted on every
`ai_assessment` row (`modelId`), alongside `promptVersion` and
`schemaVersion`, so reproducing a historical assessment never depends on
inferring any of the three from a git commit.

### Quota

`MONTHLY_ASSESSMENT_QUOTA` (`lib/ai/quota.ts`, currently 100) is enforced
by counting `ai_assessment` rows created this calendar month for the
organization -- including failed attempts, since a failed run still costs
tokens and a failed-retry loop must not be a quota-bypass vector. Checked
inside the same transaction that creates the row
(`app/api/orgs/[orgId]/jobs/[jobId]/assessments/route.ts`), so two
concurrent requests cannot both slip under the limit. Separately,
`ai_usage_ledger` records token/cost accounting per attempt (success or
failure) for billing and observability -- quota *enforcement* never
depends on that table being perfectly consistent.

## Where to look

| Concern | File |
| --- | --- |
| Output schema, safety category vocabulary, request schemas | `lib/validation/assessment.ts` |
| Ordinal-ref citation resolution | `lib/ai/citations.ts` |
| Deterministic safety rules | `lib/ai/safetyRules.ts` |
| Model port, Anthropic adapter, fixture adapter | `lib/ai/modelPort.ts`, `lib/ai/anthropicModel.ts`, `lib/ai/fixtureModel.ts` |
| System prompt, tool schema projection | `lib/ai/tool.ts` |
| Executor (claim -> fetch/verify -> model call -> validate -> persist) | `lib/ai/executor.ts` |
| System-level evidence read (the one service-role use) | `lib/storage/evidenceStorageSystem.ts` |
| Resumed (non-session) tenant context for the executor | `lib/auth/session.ts`'s `withResumedOrgContext` |
| Repositories | `lib/db/repositories/assessmentRepository.ts`, `verdictRepository.ts` |
| Quota | `lib/ai/quota.ts` |
| Tables, RLS | `prisma/migrations/20260817000009_ai_assessment/`, `..._010_ai_assessment_rls/` |
| Citation-integrity constraint | `prisma/migrations/20260817000009_ai_assessment/migration.sql` (`ai_assessment_citation`'s composite FK) |
| Stuck-run reaper, queue discovery | `prisma/migrations/20260817000011_ai_assessment_reaper/`, `..._012_ai_assessment_queue/` |
| Internal endpoints | `app/api/internal/assessments/run/`, `.../reap/` |
| Proof it actually works | `tests/security/assessment-isolation.test.ts`, `assessment-executor.test.ts` |
| Model-quality evaluation (opt-in, not CI) | `tests/eval/` |
