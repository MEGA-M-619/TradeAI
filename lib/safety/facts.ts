/**
 * The Safety Engine's fact and uncertainty model. Pure: no database, no
 * Prisma, no repositories, no routes, no rules, no thresholds, no model
 * output. This module defines only how a verified fact and an explicit
 * unknown are represented; gathering them is lib/safety/factBuilder.ts
 * (Phase 4E) and interpreting them is lib/safety/rules/ (Phase 4C).
 *
 * The whole point is the distinction this file makes unavoidable:
 *
 *     Known(value)   -- the data establishes this
 *     Unknown(reason)-- the data does not establish this, and here is why
 *
 * An Unknown must never quietly become `null`, `undefined`, `false`, `0`,
 * `""`, a default, an assumption, or a permissive state. Nothing in this
 * module lets it: there is no `unwrapOr`, no `getOrDefault`, no
 * `valueOr`, and no coercion of any kind. The only way to read a value is
 * to narrow with `isKnown` first, or to call `unwrapKnown` and accept
 * that it throws loudly on an Unknown. That asymmetry is deliberate --
 * reading a fact should be slightly inconvenient, because assuming one is
 * how people get hurt.
 *
 * Note carefully what this module does NOT decide. `Known([])` -- we
 * looked, and there is nothing -- is a completely different statement
 * from `Unknown` -- we could not establish what is there. Both may well
 * lead a Phase 4C rule to escalate, but they are not the same fact, and
 * collapsing them here would destroy the distinction the rules need.
 *
 * No SafetyState is produced, imported, or referenced anywhere in this
 * file. Facts describe the world; states are a judgement about it, and
 * that judgement belongs to the evaluator.
 */

import type { MeasurementResult } from "@/lib/diagnostics/measurementRules";
import type { MeasurementTestTypeInput } from "@/lib/validation/measurement";
import type { SafetyCategory } from "@/lib/validation/assessment";

// --- The uncertainty primitive ----------------------------------------

/**
 * Why a fact could not be established. A closed vocabulary rather than
 * free text, for the same reason SAFETY_CATEGORIES and
 * MEASUREMENT_TEST_TYPES are closed: a caller selects from a fixed list
 * instead of writing prose, so downstream code can branch on the reason
 * without parsing a string.
 *
 *   not_recorded            Nothing in the recorded data establishes it.
 *                           The technician has not entered it (yet).
 *   ambiguous               The data contains several conflicting
 *                           answers and none is authoritative. Explicitly
 *                           NOT resolved by picking the newest or the
 *                           most convenient one.
 *   depends_on_unknown_fact It cannot be determined because a
 *                           prerequisite fact is itself Unknown. This is
 *                           how uncertainty propagates rather than being
 *                           silently absorbed.
 */
export const UNKNOWN_REASONS = [
  "not_recorded",
  "ambiguous",
  "depends_on_unknown_fact",
] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export function isUnknownReason(value: unknown): value is UnknownReason {
  return (
    typeof value === "string" &&
    (UNKNOWN_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Plain data, not a class instance: every fact must survive
 * `JSON.parse(JSON.stringify(fact))` unchanged, because an evaluation's
 * basis is returned in an API response (see the approved architecture,
 * section I -- verdicts are computed on read and carry their basis).
 * A class, a Symbol discriminant, or a Map would not round-trip.
 */
export type Known<T> = {
  readonly known: true;
  readonly value: T;
};

export type Unknown = {
  readonly known: false;
  readonly reason: UnknownReason;
  /**
   * A short, caller-supplied constant naming the specific gap, e.g.
   * "no measurement on this job references a circuit". Intended for
   * developers and for assembling a technician-facing "verify X" list in
   * Phase 4C -- it explains the gap, it never suggests it is harmless.
   */
  readonly detail: string;
};

export type Fact<T> = Known<T> | Unknown;

export class InvalidFactValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFactValueError";
  }
}

export class UnknownFactAccessError extends Error {
  constructor(fact: Unknown) {
    super(
      `Attempted to read the value of an Unknown fact (${fact.reason}: ${fact.detail})`,
    );
    this.name = "UnknownFactAccessError";
  }
}

/**
 * Builds a Known fact. Rejects the values that most often *mean* "we
 * don't have this" in JavaScript but would otherwise be recorded as
 * though we did: `null`, `undefined`, and a blank string. Those must be
 * expressed as `unknown(...)` with a reason, not smuggled in as data.
 *
 * The checks are deliberately explicit rather than a truthiness test.
 * `known(false)` and `known(0)` are entirely legitimate facts and must
 * remain distinguishable from Unknown -- a falsy-value guard here would
 * be exactly the bug this module exists to prevent.
 *
 * If a future fact genuinely needs the empty string as a meaningful
 * value, that deserves its own decision rather than a quiet relaxation
 * of this guard.
 */
export function known<T>(value: T): Known<T> {
  if (value === null) {
    throw new InvalidFactValueError(
      "null is not a fact value -- use unknown(reason, detail)",
    );
  }
  if (value === undefined) {
    throw new InvalidFactValueError(
      "undefined is not a fact value -- use unknown(reason, detail)",
    );
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new InvalidFactValueError(
      "a blank string is not a fact value -- use unknown(reason, detail)",
    );
  }
  return { known: true, value };
}

/** Builds an Unknown fact. `detail` must actually say something -- an
 * unexplained unknown is not much better than a silent one. */
export function unknown(reason: UnknownReason, detail: string): Unknown {
  if (!isUnknownReason(reason)) {
    throw new InvalidFactValueError(`Not an UnknownReason: ${String(reason)}`);
  }
  if (typeof detail !== "string" || detail.trim() === "") {
    throw new InvalidFactValueError(
      "an Unknown must carry a non-empty detail explaining why the fact is unavailable",
    );
  }
  return { known: false, reason, detail };
}

export function isKnown<T>(fact: Fact<T>): fact is Known<T> {
  return fact.known === true;
}

export function isUnknown<T>(fact: Fact<T>): fact is Unknown {
  return fact.known === false;
}

/**
 * The only value accessor, and it throws rather than defaulting. There is
 * deliberately no `unwrapOr`/`getOrDefault`/`valueOr` counterpart: an API
 * that lets a caller name a fallback is an API that lets a caller turn an
 * unknown into an assumption in one keystroke. Narrow with `isKnown`
 * where the Unknown case has real handling; use this only where the
 * caller has already established the fact is Known and a violation would
 * be a programming bug. Matches the fail-loud convention in
 * lib/safety/states.ts and lib/storage/evidenceStorage.ts.
 */
export function unwrapKnown<T>(fact: Fact<T>): T {
  if (isUnknown(fact)) {
    throw new UnknownFactAccessError(fact);
  }
  return fact.value;
}

// --- The fact vocabulary ----------------------------------------------

/**
 * The closed set of facts the Phase 4 Safety Engine needs. Each key
 * exists because a rule planned for Phase 4C consumes it; nothing here is
 * speculative, and no electrical quantity beyond what the Measurement
 * model already records appears.
 *
 *   circuit_under_investigation
 *       Which circuit this diagnostic session concerns. DiagnosticSession
 *       has no circuitId column, so this is derived from the circuits the
 *       job's measurements reference -- which is precisely why it is
 *       often Unknown (`not_recorded` when none reference a circuit,
 *       `ambiguous` when they reference several).
 *
 *   measurements_on_job
 *       Every measurement recorded against the session's job. Known([])
 *       is a real answer meaning "we looked and there are none".
 *
 *   measurements_on_circuit
 *       The subset recorded against the circuit under investigation.
 *       Necessarily `depends_on_unknown_fact` whenever
 *       circuit_under_investigation is Unknown -- this pairing is the
 *       concrete example of uncertainty propagating instead of being
 *       absorbed.
 *
 *   ai_hazard_categories
 *       Hazard categories the latest completed AI assessment attached to
 *       findings the technician has not rejected, drawn from the closed
 *       SAFETY_CATEGORIES vocabulary. This is a *persisted, validated*
 *       signal, not model text: the categories were selected from a fixed
 *       list, schema-checked before storage, and are re-filtered against
 *       that list when read.
 *
 *       Known([]) when the job has no completed assessment -- we looked
 *       and there are no AI-flagged hazards, which is a fact. Treating
 *       absence as Unknown would escalate every measurement-only job,
 *       since an Unknown required fact escalates by design.
 *
 *       Carrying the categories as a fact does NOT let the model set a
 *       safety state. Rules decide what a category means, and the lattice
 *       makes any such contribution escalation-only.
 */
export const FACT_KEYS = [
  "circuit_under_investigation",
  "measurements_on_job",
  "measurements_on_circuit",
  "ai_hazard_categories",
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

export function isFactKey(value: unknown): value is FactKey {
  return (
    typeof value === "string" && (FACT_KEYS as readonly string[]).includes(value)
  );
}

/**
 * How a measurement's expected range came to be. Today there is exactly
 * one source and it is not authoritative: `expectedMin`/`expectedMax`
 * arrive in the request body (lib/validation/measurement.ts), so a caller
 * can supply any range and manufacture a `pass`. Recording the source
 * alongside the criterion is what lets a Phase 4C rule decline to treat
 * such a result as clearing a safety-relevant unknown.
 *
 * There is deliberately no `verified_standard` variant: no verified
 * electrical-standard source exists in this codebase, and adding the
 * variant before the source would invite exactly the unsourced-threshold
 * failure the architecture guards against.
 */
export type MeasurementCriterion =
  | {
      readonly source: "technician_supplied";
      readonly expectedMin: number | null;
      readonly expectedMax: number | null;
    }
  | { readonly source: "none" };

/**
 * The safety-relevant projection of a Measurement row. Deliberately not
 * the Prisma model: this module must not depend on the database layer,
 * and the engine has no business seeing `note`, `evidenceId`, or who
 * recorded it.
 *
 * `result` is nullable because the column is -- rows created before the
 * Phase 3B wiring have no computed result. A rule must treat `null` as
 * "not evaluated", never as "fine".
 *
 * `recordedAt` is an ISO-8601 string rather than a Date so the fact stays
 * JSON-round-trippable.
 */
export type MeasurementFact = {
  readonly measurementId: string;
  readonly testType: MeasurementTestTypeInput;
  readonly circuitId: string | null;
  readonly value: number;
  readonly unit: string;
  readonly result: MeasurementResult | null;
  readonly criterion: MeasurementCriterion;
  readonly recordedAt: string;
};

export type CircuitIdentification = {
  readonly circuitId: string;
  readonly label: string;
};

/**
 * The complete input to a safety evaluation. Every key is present and
 * every value is explicitly Known or Unknown -- there is no optional
 * field, so a fact can never be missing merely by omission.
 */
export type SafetyFacts = {
  readonly circuit_under_investigation: Fact<CircuitIdentification>;
  readonly measurements_on_job: Fact<readonly MeasurementFact[]>;
  readonly measurements_on_circuit: Fact<readonly MeasurementFact[]>;
  readonly ai_hazard_categories: Fact<readonly SafetyCategory[]>;
};

/**
 * Compile-time proof that SafetyFacts covers exactly FACT_KEYS -- adding
 * a key without a field (or a field without a key) is a type error, the
 * same exhaustiveness guarantee STATE_PRECEDENCE relies on in
 * lib/safety/states.ts.
 */
type FactKeysCoverSafetyFacts = FactKey extends keyof SafetyFacts
  ? keyof SafetyFacts extends FactKey
    ? true
    : never
  : never;
const _factKeyCoverage: FactKeysCoverSafetyFacts = true;
void _factKeyCoverage;

/** True when every fact in the set is Known. Reports on the facts; it
 * reaches no conclusion about safety, which is the evaluator's job.
 *
 * Reads the `known` discriminant directly rather than going through
 * `isKnown`: indexing SafetyFacts with a FactKey union yields a union of
 * differently-parameterised Fact types, which the generic guard cannot
 * unify. The discriminant is common to both variants, so this is exactly
 * as safe and needs no cast. */
export function allFactsKnown(facts: SafetyFacts): boolean {
  return FACT_KEYS.every((key) => facts[key].known);
}

/** The keys whose facts are Unknown, in FACT_KEYS order so the result is
 * deterministic rather than dependent on object iteration order. */
export function unknownFactKeys(facts: SafetyFacts): FactKey[] {
  return FACT_KEYS.filter((key) => !facts[key].known);
}
