import { unwrapKnown } from "@/lib/safety/facts";
import type { SafetyRule } from "@/lib/safety/rules/types";

/**
 * Nothing has been measured on the circuit under investigation.
 *
 * Note this fires on `Known([])` -- we looked, and there is nothing --
 * which is a different fact from Unknown and reaches this rule by a
 * different path. When the circuit itself is unidentified,
 * measurements_on_circuit arrives Unknown (`depends_on_unknown_fact`) and
 * the generic missing-fact path escalates instead, so this rule requires
 * only the one fact and lets the propagation already modelled in
 * lib/safety/facts.ts do its work.
 *
 * No threshold: this is a question about whether a reading exists at all,
 * not about what any reading means.
 */
export const noMeasurementOnCircuitRule: SafetyRule = {
  id: "no_measurement_on_circuit",
  requires: ["measurements_on_circuit"],
  sourceStatus: "no_threshold_required",
  whenUnknown: {
    message:
      "Whether any measurement exists for the circuit under investigation could not be established.",
    verify:
      "Identify the circuit under investigation, then record measurements against it.",
  },
  evaluate: (facts) => {
    const measurements = unwrapKnown(facts.measurements_on_circuit);
    if (measurements.length > 0) return null;
    return {
      state: "INSUFFICIENT_INFORMATION",
      message:
        "No measurement has been recorded against the circuit under investigation.",
      verify:
        "Record the measurements needed to characterise this circuit before drawing conclusions about it.",
      measurementIds: [],
      criterionSource: null,
    };
  },
};
