/**
 * The Safety Engine's rule contract. Pure: no database, no repositories,
 * no routes, no model output. A rule reads a SafetyFacts value and either
 * says nothing or escalates -- it can never certify, and it can never
 * lower a state.
 *
 * The shape follows the approved hybrid design: a rule is structured DATA
 * (stable id, declared required facts, source status, constant message
 * text) carrying a pure PREDICATE. Not a generic rules DSL -- a
 * declarative-only format could not express "two measurements on this
 * circuit disagree" -- and not a bare function either, because the
 * metadata is what makes the registry auditable and drives the automatic
 * unknown-escalation. This extends the pattern CATEGORY_RULES already
 * uses in lib/ai/safetyRules.ts, where an exhaustive Record keyed on a
 * closed vocabulary makes a missing rule a compile error.
 */

import type {
  FactKey,
  MeasurementCriterion,
  MeasurementFact,
  SafetyFacts,
  UnknownReason,
} from "@/lib/safety/facts";
import type { SafetyState } from "@/lib/safety/states";
import type { SafetyCategory } from "@/lib/validation/assessment";

/**
 * Whether a rule can stand on its own logic, needs a numeric limit from a
 * published electrical standard this repository has not verified, or
 * carries a real citation for one.
 *
 *   no_threshold_required     The rule reasons about presence, absence or
 *                             contradiction and needs no magnitude. Every
 *                             rule shipping today is this.
 *   requires_verified_source  Written and reviewed, but it cannot be
 *                             stated correctly without a numeric limit
 *                             nobody has cited. The standards guard keeps
 *                             these out of ACTIVE_RULES, so a
 *                             plausible-sounding but uncited threshold
 *                             cannot quietly become a safety instruction.
 *   verified                  A real standard, edition and clause are
 *                             recorded on the rule. Only this status may
 *                             carry a `source`, and it may not be claimed
 *                             without one -- see ruleSourceProblems.
 *
 * No rule currently uses `verified`: no electrical standard has been
 * verified for this repository. The status exists so that a citation
 * becomes *expressible* the moment one is, rather than being bolted on
 * under time pressure later.
 */
export const RULE_SOURCE_STATUSES = [
  "no_threshold_required",
  "requires_verified_source",
  "verified",
] as const;

export type RuleSourceStatus = (typeof RULE_SOURCE_STATUSES)[number];

export function isRuleSourceStatus(value: unknown): value is RuleSourceStatus {
  return (
    typeof value === "string" &&
    (RULE_SOURCE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * A citation for a numeric limit a rule depends on.
 *
 * All three parts are required and none may be blank. A standard without
 * an edition is ambiguous -- limits change between editions -- and a
 * standard without a clause cannot be checked by a reader. Half a
 * citation reads as authoritative while being unverifiable, which is
 * worse than none at all.
 *
 * Free-form strings on purpose: this repository has no business
 * enumerating the world's electrical standards, and a closed list would
 * be wrong the first time someone cites a jurisdiction it omits.
 */
export type RuleSource = {
  /** e.g. the standard's identifier, exactly as published. */
  readonly standard: string;
  /** e.g. the edition or year the cited limit appears in. */
  readonly edition: string;
  /** e.g. the clause, section or table the limit is stated in. */
  readonly clause: string;
};

type SourceBearing = {
  readonly id: string;
  readonly sourceStatus: RuleSourceStatus;
  readonly source?: RuleSource;
};

/**
 * Checks a rule's citation against its claimed status, returning every
 * problem found rather than the first. Empty means coherent.
 *
 * The relationship is a biconditional: `verified` requires a complete
 * source, and a source requires `verified`. Allowing either half alone
 * would let a rule look cited without being, or be cited without the
 * status that makes the guard notice it.
 *
 * Exported so the module-load check in ./index.ts and the unit tests
 * enforce exactly the same thing, rather than two drifting copies.
 */
export function ruleSourceProblems(rule: SourceBearing): string[] {
  const problems: string[] = [];
  const blank = (value: string | undefined) =>
    typeof value !== "string" || value.trim() === "";

  if (rule.sourceStatus === "verified") {
    if (!rule.source) {
      problems.push(
        `rule "${rule.id}" claims sourceStatus "verified" but carries no source`,
      );
    } else {
      for (const part of ["standard", "edition", "clause"] as const) {
        if (blank(rule.source[part])) {
          problems.push(
            `rule "${rule.id}" is marked verified but its source.${part} is empty`,
          );
        }
      }
    }
  } else if (rule.source) {
    problems.push(
      `rule "${rule.id}" carries a source but its sourceStatus is "${rule.sourceStatus}", not "verified"`,
    );
  }

  return problems;
}

/**
 * Every rule that exists, active or deferred. Closed, so a rule id is
 * never an arbitrary string and the registry can be checked exhaustively.
 */
export const SAFETY_RULE_IDS = [
  "circuit_not_uniquely_identified",
  "no_measurement_on_circuit",
  "contradictory_measurement_results",
  "inconclusive_measurement",
  "unevaluated_measurement",
  "energized_conductor_indication",
  // One per SafetyCategory. The compile-time proof below keeps this list
  // in step with the vocabulary.
  "ai_hazard_arc_fault_suspected",
  "ai_hazard_water_ingress_energized",
  "ai_hazard_thermal_damage_scorching",
  "ai_hazard_backfed_or_double_lugged_neutral",
  "ai_hazard_missing_bonding_or_grounding",
  "ai_hazard_aluminium_branch_conductors",
  "ai_hazard_recalled_panel_brand",
  "ai_hazard_knob_and_tube_or_asbestos_era",
] as const;

export type SafetyRuleId = (typeof SAFETY_RULE_IDS)[number];

/** The id a category's rule must use. */
export type AiHazardRuleId = `ai_hazard_${SafetyCategory}`;

/**
 * Compile-time proof that every SafetyCategory has a declared rule id.
 * Adding a category to SAFETY_CATEGORIES without adding its id above
 * makes this assignment fail to typecheck, rather than leaving a hazard
 * silently unmapped.
 */
type AiHazardIdsAreDeclared =
  AiHazardRuleId extends SafetyRuleId ? true : never;
const _aiHazardIdsAreDeclared: AiHazardIdsAreDeclared = true;
void _aiHazardIdsAreDeclared;

export function isSafetyRuleId(value: unknown): value is SafetyRuleId {
  return (
    typeof value === "string" &&
    (SAFETY_RULE_IDS as readonly string[]).includes(value)
  );
}

/**
 * What a rule is permitted to emit. PROCEED_WITH_PRECAUTIONS is excluded
 * at the type level: a rule may raise the verdict or stay silent, and has
 * no vocabulary for saying "this is fine". Combined with the max-only
 * aggregation in lib/safety/states.ts, that makes it structurally
 * impossible for adding a rule to lower a verdict.
 */
export type EscalatedState = Exclude<SafetyState, "PROCEED_WITH_PRECAUTIONS">;

/**
 * Where the criteria behind a finding came from. Today the only criterion
 * any measurement can carry is `technician_supplied` -- expectedMin and
 * expectedMax arrive in the request body (lib/validation/measurement.ts),
 * so they are the technician's own expectation, not a verified standard.
 * Surfacing that in every finding is what keeps a verdict resting on an
 * unverified criterion visibly labelled as such.
 *
 * `null` means the finding does not rest on any measurement criterion.
 */
export type CriterionSourceSummary =
  | MeasurementCriterion["source"]
  | "mixed"
  | null;

/** The evidence a finding rests on, so a verdict can be audited rather
 * than taken on trust. Every field is always present, so the serialised
 * shape is stable. */
export type SafetyFindingBasis = {
  readonly factsUsed: readonly FactKey[];
  /** Sorted, so repeated evaluation of the same facts is byte-identical. */
  readonly measurementIds: readonly string[];
  readonly criterionSource: CriterionSourceSummary;
  /** Set only when the finding was produced by a missing required fact. */
  readonly unknownReason: UnknownReason | null;
};

/** What a rule reports when it has something to say. */
export type SafetyFinding = {
  readonly ruleId: SafetyRuleId;
  readonly state: EscalatedState;
  /** Always a module constant. Never generated, never model-authored. */
  readonly message: string;
  /** The concrete action that would resolve this finding. */
  readonly verify: string;
  readonly basis: SafetyFindingBasis;
};

/** A rule's own return value; `applySafetyRule` wraps it into a
 * SafetyFinding, adding the rule id and the declared facts. */
export type RuleOutcome = {
  readonly state: EscalatedState;
  readonly message: string;
  readonly verify: string;
  readonly measurementIds?: readonly string[];
  readonly criterionSource?: CriterionSourceSummary;
};

export type SafetyRule = {
  readonly id: SafetyRuleId;
  /**
   * The facts this rule needs. If any is Unknown, `applySafetyRule`
   * escalates to INSUFFICIENT_INFORMATION using `whenUnknown` and never
   * calls `evaluate`. A rule with a missing input escalates -- it does
   * not abstain.
   */
  readonly requires: readonly FactKey[];
  readonly sourceStatus: RuleSourceStatus;
  /**
   * The citation for a numeric limit this rule depends on. Present only
   * when `sourceStatus` is `verified`, and required in that case --
   * enforced by ruleSourceProblems at module load and in tests.
   *
   * Absent on every rule today, because no standard has been verified for
   * this repository.
   */
  readonly source?: RuleSource;
  /** Constant text used when a required fact is Unknown. */
  readonly whenUnknown: {
    readonly message: string;
    readonly verify: string;
  };
  /**
   * Pure. Called only when every required fact is Known, so it may
   * `unwrapKnown` those facts. Returns null when the rule has nothing to
   * say -- which is silence, not approval.
   */
  readonly evaluate: (facts: SafetyFacts) => RuleOutcome | null;
};

/**
 * Criterion sources the engine is entitled to rely on as authoritative.
 *
 * Deliberately empty. No verified electrical-standard source exists in
 * this repository, so there is nothing to put here, and inventing an
 * entry would be exactly the unsourced-threshold failure the standards
 * guard exists to prevent. When a real source is obtained and cited, it
 * gains a variant on MeasurementCriterion and an entry here.
 */
export const VERIFIED_CRITERION_SOURCES: readonly MeasurementCriterion["source"][] =
  [];

/** Summarises the criterion sources behind a set of measurements, so a
 * finding records what its conclusion actually rested on. */
export function summariseCriterionSource(
  measurements: readonly MeasurementFact[],
): CriterionSourceSummary {
  if (measurements.length === 0) return null;
  const sources = new Set(measurements.map((m) => m.criterion.source));
  if (sources.size > 1) return "mixed";
  return [...sources][0];
}
