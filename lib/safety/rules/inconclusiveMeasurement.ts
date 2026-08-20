import { unwrapKnown } from "@/lib/safety/facts";
import {
  summariseCriterionSource,
  type SafetyRule,
} from "@/lib/safety/rules/types";

/**
 * A recorded measurement came back inconclusive.
 *
 * `inconclusive` is produced by evaluateMeasurementResult
 * (lib/diagnostics/measurementRules.ts) when a reading cannot honestly be
 * judged at all -- a non-finite value, or an inverted expected range. A
 * reading the engine could not interpret must not be quietly passed over:
 * it leaves a real gap, and the gap is what this rule reports.
 *
 * No threshold: it reads an already-computed result and never inspects a
 * magnitude.
 */
export const inconclusiveMeasurementRule: SafetyRule = {
  id: "inconclusive_measurement",
  requires: ["measurements_on_job"],
  sourceStatus: "no_threshold_required",
  whenUnknown: {
    message:
      "The measurements recorded on this job could not be established, so they could not be checked for inconclusive readings.",
    verify: "Record the measurements taken on this job.",
  },
  evaluate: (facts) => {
    const inconclusive = unwrapKnown(facts.measurements_on_job).filter(
      (measurement) => measurement.result === "inconclusive",
    );
    if (inconclusive.length === 0) return null;

    return {
      state: "INSUFFICIENT_INFORMATION",
      message:
        "One or more recorded measurements were inconclusive and could not be interpreted.",
      verify:
        "Repeat each inconclusive measurement until a definite reading is obtained.",
      measurementIds: inconclusive.map((m) => m.measurementId).sort(),
      criterionSource: summariseCriterionSource(inconclusive),
    };
  },
};
