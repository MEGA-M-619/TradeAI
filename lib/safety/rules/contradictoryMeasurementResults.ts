import { unwrapKnown, type MeasurementFact } from "@/lib/safety/facts";
import {
  summariseCriterionSource,
  type SafetyRule,
} from "@/lib/safety/rules/types";

/**
 * Two measurements of the same test type on the same circuit disagree.
 *
 * A contradiction is escalated, never resolved. The engine does not take
 * the most recent reading, the most favourable one, or an average -- all
 * three would be the engine inventing a fact it does not have. It reports
 * the disagreement and asks for a re-test.
 *
 * Threshold-free by construction: it compares two already-computed
 * `result` values and never inspects a magnitude. Measurements with no
 * circuit are grouped separately from each other only by test type, since
 * two unattributed readings of the same type still cannot both be right.
 */

const UNATTRIBUTED = "unattributed";

function groupKey(measurement: MeasurementFact): string {
  return `${measurement.circuitId ?? UNATTRIBUTED}::${measurement.testType}`;
}

export const contradictoryMeasurementResultsRule: SafetyRule = {
  id: "contradictory_measurement_results",
  requires: ["measurements_on_job"],
  sourceStatus: "no_threshold_required",
  whenUnknown: {
    message:
      "The measurements recorded on this job could not be established, so they could not be checked for contradictions.",
    verify: "Record the measurements taken on this job.",
  },
  evaluate: (facts) => {
    const measurements = unwrapKnown(facts.measurements_on_job);

    const groups = new Map<string, MeasurementFact[]>();
    for (const measurement of measurements) {
      const key = groupKey(measurement);
      const existing = groups.get(key);
      if (existing) existing.push(measurement);
      else groups.set(key, [measurement]);
    }

    const conflicting: MeasurementFact[] = [];
    for (const group of groups.values()) {
      const hasPass = group.some((m) => m.result === "pass");
      const hasFail = group.some((m) => m.result === "fail");
      if (hasPass && hasFail) {
        conflicting.push(
          ...group.filter((m) => m.result === "pass" || m.result === "fail"),
        );
      }
    }

    if (conflicting.length === 0) return null;

    return {
      state: "INSUFFICIENT_INFORMATION",
      message:
        "Two or more measurements of the same test type on the same circuit disagree.",
      verify:
        "Re-test to establish which reading is correct. A disagreement is not settled by preferring the most recent or the most favourable result.",
      // Sorted so repeated evaluation of the same facts is identical.
      measurementIds: conflicting.map((m) => m.measurementId).sort(),
      criterionSource: summariseCriterionSource(conflicting),
    };
  },
};
