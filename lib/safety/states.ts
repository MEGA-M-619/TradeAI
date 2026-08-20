/**
 * The Safety Engine's state lattice. Pure: no database access, no model
 * involvement, no clock, no randomness. This module owns the definition
 * of what safety states exist, how they rank, and the single operation
 * by which they combine.
 *
 * The governing property is that combination is a RATCHET. `maxState` and
 * `aggregateSafetyStates` are the only combinators, and both return the
 * most restrictive of their inputs. There is deliberately no `minState`,
 * no `downgrade`, no `clear`, and no function anywhere in this module
 * that accepts a prior state and returns a less restrictive one. A
 * situation leaves a restrictive state only by the underlying facts
 * changing and a fresh evaluation being computed from scratch -- never by
 * a caller asking for it. This is what makes it structurally impossible
 * for any future component (the diagnostic engine, an API route, or the
 * Phase 6 local model) to talk the system down from STOP: there is no
 * argument it could pass to do so.
 *
 * There is no SAFE / ALL_CLEAR / PASS state, and adding one would be a
 * design regression rather than a feature. TradeAI cannot inspect a
 * physical installation, so it has no basis on which to certify one. This
 * matches the invariant already enforced in lib/validation/assessment.ts
 * ("no isSafe/isCodeCompliant boolean exists -- the model has nowhere to
 * declare something safe or compliant") and the standing instruction in
 * lib/ai/tool.ts's system prompt never to imply anything is safe to
 * touch. The least restrictive state this engine can reach is
 * PROCEED_WITH_PRECAUTIONS, which is a statement about what the system
 * knows, not a certification of the installation.
 *
 * Phase 4A is the state model only. Facts, rules, evaluation, and the
 * fact builder arrive in later steps; nothing here reads a Measurement,
 * a DiagnosticSession, or any model output.
 */

/**
 * Bumped whenever the meaning of a state, the precedence order, or (once
 * they exist) the active rule set changes. Returned alongside every
 * verdict so a recorded evaluation can later be interpreted against the
 * rules that actually produced it. Same convention as PROMPT_VERSION /
 * SCHEMA_VERSION in lib/ai/tool.ts.
 */
export const RULESET_VERSION = "2026-08-19.1";

/**
 * The closed vocabulary, ordered least to most restrictive. Declared as a
 * const tuple so SafetyState is a closed union rather than `string` --
 * the same discipline as SAFETY_CATEGORIES (lib/validation/assessment.ts)
 * and MEASUREMENT_TEST_TYPES (lib/validation/measurement.ts).
 */
export const SAFETY_STATES = [
  "PROCEED_WITH_PRECAUTIONS",
  "INSUFFICIENT_INFORMATION",
  "STOP",
] as const;

export type SafetyState = (typeof SAFETY_STATES)[number];

/**
 * Ordinal precedence. Higher wins. Typed as an exhaustive
 * Record<SafetyState, number> so adding a state to SAFETY_STATES without
 * ranking it here is a compile error, not a silent gap -- the same
 * exhaustiveness guarantee CATEGORY_RULES relies on in
 * lib/ai/safetyRules.ts.
 *
 * Why this order:
 *   - STOP outranks everything: a positively identified hazard is both
 *     more restrictive and more actionable than an open question.
 *   - INSUFFICIENT_INFORMATION outranks PROCEED_WITH_PRECAUTIONS because
 *     unknown is not safe. That single relation is the reason this
 *     lattice exists at all; collapsing it would let missing information
 *     read as an absence of concern.
 */
export const STATE_PRECEDENCE: Record<SafetyState, number> = {
  PROCEED_WITH_PRECAUTIONS: 0,
  INSUFFICIENT_INFORMATION: 1,
  STOP: 2,
};

/**
 * The identity element for aggregation, and the least restrictive state
 * reachable. Baseline precautions still apply here -- attaching them is
 * the evaluator's job (Phase 4D), not this module's.
 */
export const FLOOR_STATE: SafetyState = "PROCEED_WITH_PRECAUTIONS";

/**
 * Thrown when a value that is not a member of SAFETY_STATES reaches a
 * combinator. TypeScript already prevents this at compile time, so this
 * is a runtime backstop for a caller that crossed a type boundary (a
 * JSON payload, a cast, a future deserializer).
 *
 * It throws rather than coercing, on purpose. Silently treating an
 * unrecognized value as the floor could drop a STOP; silently treating it
 * as STOP would raise a false alarm from what is really a programming
 * bug and would teach users to distrust the state that matters most.
 * Failing loudly on a should-be-unreachable input matches the existing
 * convention in lib/storage/evidenceStorage.ts (buildEvidenceKey) and
 * lib/ai/imagePayload.ts.
 */
export class UnknownSafetyStateError extends Error {
  constructor(received: unknown) {
    super(`Not a SafetyState: ${JSON.stringify(received)}`);
    this.name = "UnknownSafetyStateError";
  }
}

export function isSafetyState(value: unknown): value is SafetyState {
  return (
    typeof value === "string" &&
    (SAFETY_STATES as readonly string[]).includes(value)
  );
}

function precedenceOf(state: SafetyState): number {
  if (!isSafetyState(state)) {
    throw new UnknownSafetyStateError(state);
  }
  return STATE_PRECEDENCE[state];
}

/**
 * The lattice join: returns whichever of the two states is more
 * restrictive. Commutative, associative, and idempotent -- properties the
 * unit tests assert directly, because aggregation order must never change
 * a verdict.
 */
export function maxState(a: SafetyState, b: SafetyState): SafetyState {
  return precedenceOf(a) >= precedenceOf(b) ? a : b;
}

/**
 * Folds any number of states into one. An empty input yields FLOOR_STATE:
 * with no rule having raised anything there is nothing to escalate, and
 * the floor still carries mandatory precautions, so this is the correct
 * identity rather than a permissive shortcut. Note the asymmetry with an
 * *unknown* fact, which is emphatically not empty -- that produces
 * INSUFFICIENT_INFORMATION once rules exist (Phase 4C), and is the
 * distinction this whole design turns on.
 */
export function aggregateSafetyStates(
  states: readonly SafetyState[],
): SafetyState {
  return states.reduce<SafetyState>(maxState, FLOOR_STATE);
}

// Module-load invariant checks. Asserted at import time so a future edit
// that breaks the lattice fails immediately and everywhere, rather than
// in whichever test happens to notice first. Same pattern as the
// constant cross-check in lib/validation/assessment.ts and the provider-
// ceiling self-check in lib/ai/imagePayload.ts.
{
  const ranks = SAFETY_STATES.map((state) => STATE_PRECEDENCE[state]);

  if (new Set(ranks).size !== ranks.length) {
    throw new Error(
      "STATE_PRECEDENCE must assign a distinct rank to every SafetyState",
    );
  }
  // SAFETY_STATES is declared least-to-most restrictive; the ranks must
  // agree with that declared order, so the two cannot drift apart.
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] <= ranks[i - 1]) {
      throw new Error(
        "STATE_PRECEDENCE must increase in the order SAFETY_STATES declares",
      );
    }
  }
  if (STATE_PRECEDENCE[FLOOR_STATE] !== Math.min(...ranks)) {
    throw new Error("FLOOR_STATE must be the least restrictive SafetyState");
  }
}
