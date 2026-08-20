/**
 * The deterministic measurement rule engine. Pure function, no model
 * involvement, no database access -- see the doc comment on
 * Measurement.result in schema.prisma, which this module exists to
 * satisfy: `result` must be computed, never chosen freehand by a
 * technician or inferred by a model.
 *
 * Deliberately scoped to a pure numeric range check against whatever
 * expectedMin/expectedMax a technician supplied for *this* reading, not
 * test-type-specific domain thresholds (e.g. a minimum insulation
 * resistance per NEC/IEC, or a maximum acceptable voltage drop). Encoding
 * a real electrical standard's numeric limits into this file would be a
 * safety-relevant claim this codebase has no cited source for and cannot
 * verify -- doing that responsibly is a separate, later change with a
 * real reference per test type, not something to fold into "the range
 * check" as a side effect. Until then, a reading with no expected range
 * is `not_applicable`, not a guess.
 *
 * Wired into the create-measurement route
 * (app/api/orgs/[orgId]/jobs/[jobId]/measurements/route.ts), which calls
 * this synchronously inside the same transaction that writes the row, so
 * Measurement.result is populated at creation time. There is no update
 * path that recomputes it: a stored result always reflects the criterion
 * supplied when the reading was recorded.
 */

export type MeasurementResult = "pass" | "fail" | "inconclusive" | "not_applicable";

export type MeasurementEvaluationInput = {
  value: number;
  expectedMin?: number | null;
  expectedMax?: number | null;
};

/**
 * Bounds are inclusive: a value exactly at expectedMin or expectedMax is
 * a pass. Either bound may be omitted for a half-open range ("must be at
 * least X" / "must be at most X"); both omitted means there is nothing to
 * evaluate against, which is `not_applicable`, not `pass`.
 *
 * `inconclusive` is reserved for inputs the engine cannot honestly
 * evaluate at all -- a non-finite value, or an inverted range
 * (expectedMin > expectedMax). lib/validation/measurement.ts already
 * rejects both before a row is ever created, so these are a defensive
 * backstop for a caller that didn't go through that schema, not an
 * expected path from the API.
 */
export function evaluateMeasurementResult(
  input: MeasurementEvaluationInput,
): MeasurementResult {
  const { value } = input;
  const min = input.expectedMin ?? null;
  const max = input.expectedMax ?? null;

  if (!Number.isFinite(value)) {
    return "inconclusive";
  }

  if (min === null && max === null) {
    return "not_applicable";
  }

  if (min !== null && !Number.isFinite(min)) {
    return "inconclusive";
  }
  if (max !== null && !Number.isFinite(max)) {
    return "inconclusive";
  }
  if (min !== null && max !== null && min > max) {
    return "inconclusive";
  }

  const aboveMin = min === null || value >= min;
  const belowMax = max === null || value <= max;

  return aboveMin && belowMax ? "pass" : "fail";
}
