/**
 * The Safety Engine's evaluator: the fold that turns rule findings into
 * one verdict. Pure -- no database, no repositories, no routes, no model
 * output, no clock, no randomness.
 *
 * The whole computation is: apply every active rule, collect what fired,
 * and take the most restrictive state any of them reported. Combination
 * happens only through aggregateSafetyStates (lib/safety/states.ts),
 * which is a max over the lattice, so this module has no downgrade
 * operation and could not express one -- a finding can raise the verdict
 * or leave it alone, never lower it.
 *
 * What the verdict does NOT mean. PROCEED_WITH_PRECAUTIONS is the floor:
 * it says no active rule escalated, nothing more. It is not a statement
 * that anything is safe, de-energized, safe to touch, or code compliant,
 * and this module contains no vocabulary for any of those claims. The
 * baseline precautions below are attached to every evaluation, at every
 * state, precisely so the floor is never read as an all-clear.
 *
 * Deliberately absent: any producer of STOP. No active rule returns it
 * today, because every threshold-free rule available from the recorded
 * data tops out at INSUFFICIENT_INFORMATION, and a rule that positively
 * identifies a hazard would need a numeric limit from a verified
 * standard this repository does not have (see lib/safety/rules/
 * deferred.ts). STOP exists in the lattice, is handled correctly here,
 * and simply has nothing to emit it yet. That is the honest position; the
 * alternative would be inventing a threshold to make it light up.
 */

import type { FactKey, SafetyFacts } from "@/lib/safety/facts";
import { unknownFactKeys } from "@/lib/safety/facts";
import {
  RULESET_VERSION,
  aggregateSafetyStates,
  type SafetyState,
} from "@/lib/safety/states";
import {
  ACTIVE_RULES,
  applySafetyRule,
  type SafetyFinding,
  type SafetyRule,
  type SafetyRuleId,
} from "@/lib/safety/rules";

/**
 * Precautions attached to every evaluation regardless of state, the same
 * way lib/ai/safetyRules.ts attaches its baseline warnings to every
 * assessment. Text is a module constant -- never generated, never
 * model-authored.
 *
 * Note the wording carefully: each one describes what this evaluation is
 * NOT, or names an action the technician must take. None asserts a
 * condition of the installation. "Independently verify absence of
 * voltage" is an instruction precisely because the engine cannot
 * establish that absence itself.
 */
export const BASELINE_PRECAUTION_IDS = [
  "not_an_inspection",
  "verify_absence_of_voltage",
  "code_authority_defers",
] as const;

export type BaselinePrecautionId = (typeof BASELINE_PRECAUTION_IDS)[number];

export type SafetyPrecaution = {
  readonly id: BaselinePrecautionId;
  readonly message: string;
};

const BASELINE_PRECAUTIONS: readonly SafetyPrecaution[] = [
  {
    id: "not_an_inspection",
    // Phrased to avoid the words "is safe" even inside a negation: the
    // invariant test scans emitted text for safety claims and cannot tell
    // an assertion from its denial. Keeping the guard strict and the
    // prose plain is the better trade.
    message:
      "This evaluation is computed from recorded data only. It is not an inspection of the installation, and it never certifies the condition of any part of it.",
  },
  {
    id: "verify_absence_of_voltage",
    message:
      "Independently verify absence of voltage before contact with any conductor, terminal, or component, whatever this evaluation reports.",
  },
  {
    id: "code_authority_defers",
    message:
      "Code compliance and inspection requirements are determined by the applicable local authority, not by this evaluation.",
  },
];

export type SafetyEvaluation = {
  /** The aggregate verdict: the most restrictive state any rule reported,
   * or the floor if none did. Never a certification. */
  readonly state: SafetyState;
  /** Which rule set produced this, so a recorded verdict can later be
   * interpreted against the rules that actually made it. */
  readonly rulesetVersion: string;
  /** Always present, at every state. */
  readonly precautions: readonly SafetyPrecaution[];
  /** Every finding that fired, in rule-registry order. Each carries its
   * own basis, including criterionSource. */
  readonly findings: readonly SafetyFinding[];
  /** The ids of the rules that fired, in the same order as findings. */
  readonly firedRuleIds: readonly SafetyRuleId[];
  /** What the technician would need to do to resolve the findings.
   * De-duplicated, first-occurrence order preserved. */
  readonly verifications: readonly string[];
  /** Which facts were Unknown, in FACT_KEYS order. Keeps "we could not
   * establish this" visible in the result rather than collapsed into the
   * findings -- an Unknown fact is not the same as a rule firing. */
  readonly unknownFacts: readonly FactKey[];
};

/**
 * Evaluates a set of facts against the active rules.
 *
 * `rules` is injectable purely so tests can exercise states no shipping
 * rule currently produces (notably STOP) and can prove that registry
 * ordering does not affect the verdict. Production callers pass nothing
 * and get ACTIVE_RULES. Injecting a rule cannot weaken the result:
 * applySafetyRule rejects any outcome at the floor state, so an injected
 * rule can only escalate or stay silent.
 */
export function evaluateSafety(
  facts: SafetyFacts,
  rules: readonly SafetyRule[] = ACTIVE_RULES,
): SafetyEvaluation {
  const findings: SafetyFinding[] = [];
  for (const rule of rules) {
    const finding = applySafetyRule(rule, facts);
    if (finding !== null) findings.push(finding);
  }

  // The only combinator. A max over the lattice, so the result dominates
  // every finding and an empty set yields the floor.
  const state = aggregateSafetyStates(findings.map((finding) => finding.state));

  // De-duplicated by value, preserving first-occurrence order: several
  // rules can legitimately ask for the same verification, and repeating
  // it would make the list read as more work than it is.
  const verifications: string[] = [];
  for (const finding of findings) {
    if (!verifications.includes(finding.verify)) {
      verifications.push(finding.verify);
    }
  }

  return {
    state,
    rulesetVersion: RULESET_VERSION,
    // Copied rather than shared, so a caller cannot mutate the constant.
    precautions: BASELINE_PRECAUTIONS.map((precaution) => ({ ...precaution })),
    findings,
    firedRuleIds: findings.map((finding) => finding.ruleId),
    verifications,
    unknownFacts: unknownFactKeys(facts),
  };
}

export { BASELINE_PRECAUTIONS };
