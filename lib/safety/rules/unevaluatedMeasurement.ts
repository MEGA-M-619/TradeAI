import { unwrapKnown } from "@/lib/safety/facts";
import {
  summariseCriterionSource,
  type SafetyRule,
} from "@/lib/safety/rules/types";

/**
 * A number was recorded with nothing to judge it against.
 *
 * Two cases, both meaning "we have a reading but no criterion":
 *   result === "not_applicable"  no expected range was supplied, so
 *                                evaluateMeasurementResult had no basis
 *                                on which to return pass or fail.
 *   result === null              the row predates the Phase 3B wiring and
 *                                was never evaluated at all.
 *
 * A rule must treat `null` as "not evaluated", never as "fine" -- which
 * is precisely why the fact model keeps the column nullable rather than
 * defaulting it.
 *
 * Note what this rule deliberately does NOT do: it does not fire merely
 * because a criterion is technician-supplied. Every criterion in the
 * system currently is, so that would make the rule fire on every
 * measurement ever recorded and stop distinguishing anything. The
 * unverified nature of technician-supplied ranges is instead carried on
 * every finding's `criterionSource`, so a verdict resting on one is
 * visibly labelled rather than silently trusted. See the note in
 * lib/safety/rules/index.ts on why that is sufficient here.
 *
 * No threshold: presence or absence of a criterion, never a magnitude.
 */
export const unevaluatedMeasurementRule: SafetyRule = {
  id: "unevaluated_measurement",
  requires: ["measurements_on_job"],
  sourceStatus: "no_threshold_required",
  whenUnknown: {
    message:
      "The measurements recorded on this job could not be established, so they could not be checked for unevaluated readings.",
    verify: "Record the measurements taken on this job.",
  },
  evaluate: (facts) => {
    const unevaluated = unwrapKnown(facts.measurements_on_job).filter(
      (measurement) =>
        measurement.result === null || measurement.result === "not_applicable",
    );
    if (unevaluated.length === 0) return null;

    return {
      state: "INSUFFICIENT_INFORMATION",
      message:
        "One or more measurements were recorded with no criterion against which to evaluate them.",
      verify:
        "State the expected range for each unevaluated reading, or record why no criterion applies to it.",
      measurementIds: unevaluated.map((m) => m.measurementId).sort(),
      criterionSource: summariseCriterionSource(unevaluated),
    };
  },
};
