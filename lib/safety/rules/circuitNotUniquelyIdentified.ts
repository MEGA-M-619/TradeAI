import type { SafetyRule } from "@/lib/safety/rules/types";

/**
 * The circuit under investigation must be uniquely identifiable.
 *
 * DiagnosticSession has no circuitId column, so the circuit is derived
 * from the circuits the job's measurements reference. That derivation
 * fails in two ways the fact model already distinguishes: `not_recorded`
 * when no measurement names a circuit, and `ambiguous` when several
 * disagree. Either way the fact arrives Unknown.
 *
 * This rule is therefore made entirely of its unknown case: `evaluate`
 * always returns null, because there is nothing to complain about once
 * the circuit IS identified. The rule exists to declare the requirement
 * and to own the constant text used when it is not met -- the escalation
 * itself comes from the generic missing-fact path in applySafetyRule.
 */
export const circuitNotUniquelyIdentifiedRule: SafetyRule = {
  id: "circuit_not_uniquely_identified",
  requires: ["circuit_under_investigation"],
  sourceStatus: "no_threshold_required",
  whenUnknown: {
    message:
      "The circuit under investigation could not be uniquely identified from the measurements recorded on this job.",
    verify:
      "Record measurements against the specific circuit being investigated, so every reading can be attributed to one circuit.",
  },
  evaluate: () => null,
};
