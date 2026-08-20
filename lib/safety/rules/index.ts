/**
 * The Safety Engine's rule registry, and the single place a rule is
 * applied to a set of facts.
 *
 * What lives here: the active rule set, and `applySafetyRule`, which
 * enforces the one behaviour every rule shares -- a required fact that is
 * Unknown escalates to INSUFFICIENT_INFORMATION rather than letting the
 * rule abstain. Aggregating findings into a single verdict, attaching the
 * baseline precautions, and stamping the ruleset version are the
 * evaluator's job (Phase 4D), not this module's.
 *
 * On technician-supplied criteria. Every expected range in the system
 * arrives in a request body (lib/validation/measurement.ts), so a caller
 * could post any range and manufacture a `pass`. Two things keep that
 * from mattering. First, no rule treats `pass` as evidence of anything --
 * rules only ever escalate, and none of them consults `pass` at all
 * except to notice that it contradicts a `fail`. Second, and more
 * fundamentally, the engine has no permissive verdict to manufacture:
 * PROCEED_WITH_PRECAUTIONS means "no rule escalated", carries mandatory
 * precautions, and is explicitly not a certification that anything is
 * safe. Every finding additionally records `criterionSource`, so a
 * verdict resting on an unverified criterion says so.
 */

import {
  FACT_KEYS,
  type FactKey,
  type SafetyFacts,
  type UnknownReason,
} from "@/lib/safety/facts";
import { FLOOR_STATE, isSafetyState } from "@/lib/safety/states";
import { circuitNotUniquelyIdentifiedRule } from "@/lib/safety/rules/circuitNotUniquelyIdentified";
import { contradictoryMeasurementResultsRule } from "@/lib/safety/rules/contradictoryMeasurementResults";
import { inconclusiveMeasurementRule } from "@/lib/safety/rules/inconclusiveMeasurement";
import { noMeasurementOnCircuitRule } from "@/lib/safety/rules/noMeasurementOnCircuit";
import { unevaluatedMeasurementRule } from "@/lib/safety/rules/unevaluatedMeasurement";
import { aiHazardRules } from "@/lib/safety/rules/aiHazardCategories";
import { DEFERRED_RULES } from "@/lib/safety/rules/deferred";
import {
  SAFETY_RULE_IDS,
  ruleSourceProblems,
  type SafetyFinding,
  type SafetyRule,
  type SafetyRuleId,
} from "@/lib/safety/rules/types";

export * from "@/lib/safety/rules/types";
export { DEFERRED_RULES, DeferredRuleInvokedError } from "@/lib/safety/rules/deferred";

/**
 * The rules that actually run. Order is fixed so evaluation is
 * reproducible; it carries no priority meaning, because findings combine
 * by taking the most restrictive state rather than by first-match.
 */
export const ACTIVE_RULES: readonly SafetyRule[] = [
  circuitNotUniquelyIdentifiedRule,
  noMeasurementOnCircuitRule,
  contradictoryMeasurementResultsRule,
  inconclusiveMeasurementRule,
  unevaluatedMeasurementRule,
  // One per hazard category the assessment can flag. These are the only
  // rules whose trigger originates outside the measurement data, and the
  // only current producers of STOP.
  ...aiHazardRules,
];

export class InvalidRuleOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuleOutcomeError";
  }
}

/** The reason a fact is Unknown, without needing to narrow a union of
 * differently-parameterised Fact types. Both variants are discriminated,
 * and only Unknown carries `reason`. */
function unknownReasonOf(fact: SafetyFacts[FactKey]): UnknownReason | null {
  return "reason" in fact ? fact.reason : null;
}

/**
 * Applies one rule to one set of facts.
 *
 * Missing-fact handling is the load-bearing part: if any declared
 * requirement is Unknown, the rule's `evaluate` is never called and the
 * result is INSUFFICIENT_INFORMATION carrying that rule's constant
 * explanation. A rule can therefore never "not fire" merely because its
 * input was absent -- which is the executable form of unknown != safe.
 *
 * Returns null only when every required fact was Known and the rule's
 * predicate had nothing to report. That is silence, not approval.
 */
export function applySafetyRule(
  rule: SafetyRule,
  facts: SafetyFacts,
): SafetyFinding | null {
  const missing = rule.requires.filter((key) => !facts[key].known);

  if (missing.length > 0) {
    return {
      ruleId: rule.id,
      state: "INSUFFICIENT_INFORMATION",
      message: rule.whenUnknown.message,
      verify: rule.whenUnknown.verify,
      basis: {
        factsUsed: [...rule.requires],
        measurementIds: [],
        criterionSource: null,
        unknownReason: unknownReasonOf(facts[missing[0]]),
      },
    };
  }

  const outcome = rule.evaluate(facts);
  if (outcome === null) return null;

  // A rule may only escalate. The type system already forbids emitting
  // the floor state; this is the runtime backstop for a value that
  // crossed a type boundary, and it fails loudly rather than silently
  // admitting a permissive verdict.
  if (!isSafetyState(outcome.state) || outcome.state === FLOOR_STATE) {
    throw new InvalidRuleOutcomeError(
      `Rule "${rule.id}" returned ${JSON.stringify(outcome.state)}; rules may only escalate`,
    );
  }

  return {
    ruleId: rule.id,
    state: outcome.state,
    message: outcome.message,
    verify: outcome.verify,
    basis: {
      factsUsed: [...rule.requires],
      measurementIds: outcome.measurementIds ? [...outcome.measurementIds] : [],
      criterionSource: outcome.criterionSource ?? null,
      unknownReason: null,
    },
  };
}

/**
 * Applies every active rule, in registry order, and returns the findings
 * that resulted. Deliberately does NOT reduce them to a single state --
 * that is Phase 4D's evaluator, along with the baseline precautions and
 * the ruleset version.
 */
export function applyActiveRules(facts: SafetyFacts): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const rule of ACTIVE_RULES) {
    const finding = applySafetyRule(rule, facts);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

/** Every rule that exists, active or deferred. */
export const ALL_RULES: readonly SafetyRule[] = [
  ...ACTIVE_RULES,
  ...DEFERRED_RULES,
];

export function getRuleById(id: SafetyRuleId): SafetyRule | undefined {
  return ALL_RULES.find((rule) => rule.id === id);
}

// Module-load invariants. Asserted at import time so a registry mistake
// fails immediately and everywhere, matching the self-check pattern in
// lib/safety/states.ts and lib/ai/imagePayload.ts.
{
  const activeIds = ACTIVE_RULES.map((rule) => rule.id);
  if (new Set(activeIds).size !== activeIds.length) {
    throw new Error("ACTIVE_RULES contains a duplicate rule id");
  }

  const allIds = ALL_RULES.map((rule) => rule.id);
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("ALL_RULES contains a duplicate rule id");
  }
  for (const id of allIds) {
    if (!(SAFETY_RULE_IDS as readonly string[]).includes(id)) {
      throw new Error(`Rule id "${id}" is not in the closed SAFETY_RULE_IDS`);
    }
  }
  for (const id of SAFETY_RULE_IDS) {
    if (!allIds.includes(id)) {
      throw new Error(`SAFETY_RULE_IDS declares "${id}" but no rule implements it`);
    }
  }

  // Citation coherence, checked across every rule including the deferred
  // ones: `verified` may not be claimed without a complete standard,
  // edition and clause, and a citation may not be attached without that
  // status. Half a citation reads as authoritative while being
  // unverifiable, which is worse than none.
  for (const rule of ALL_RULES) {
    const problems = ruleSourceProblems(rule);
    if (problems.length > 0) {
      throw new Error(problems.join("; "));
    }
  }

  // The standards guard, enforced at import as well as in tests: a rule
  // needing an unverified electrical threshold must never be active.
  for (const rule of ACTIVE_RULES) {
    if (rule.sourceStatus === "requires_verified_source") {
      throw new Error(
        `Rule "${rule.id}" requires a verified source and must not be in ACTIVE_RULES`,
      );
    }
    for (const key of rule.requires) {
      if (!(FACT_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `Rule "${rule.id}" requires unknown fact key "${key}"`,
        );
      }
    }
  }
}
