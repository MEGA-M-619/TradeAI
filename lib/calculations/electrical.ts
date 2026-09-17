/**
 * Deterministic Ohm's-law and power calculations. Pure functions, no model
 * involvement, no database access -- the same contract as
 * lib/diagnostics/measurementRules.ts, and for the same reason.
 *
 * WHY THIS EXISTS AS APPLICATION CODE AND NOT AS A MODEL CAPABILITY
 *
 * An LLM asked to compute V = I x R will usually get it right and will
 * occasionally get it wrong, with no signal at the call site distinguishing
 * the two. For a number a technician may act on in front of an energized
 * panel, "usually right" is the wrong reliability class. These four
 * relationships are exactly specified, cheap to evaluate, and trivially
 * testable, so they belong in code that either returns a correct answer or
 * an explicit refusal -- never a plausible-looking guess.
 *
 * The model's role is unchanged and complementary: it may explain what a
 * result means or which relationship applies, but the digits it repeats
 * must come from `solve` below. lib/ai/tool.ts's SYSTEM_PROMPT already
 * forbids the assessment model from inventing measured values; this module
 * is the other half of that guarantee -- the derived values.
 *
 * SCOPE, AND WHAT IS DELIBERATELY NOT HERE
 *
 * DC / single-phase-resistive relationships only. Anything requiring a
 * power factor, phase angle, reactance, or a three-phase sqrt(3) term is
 * NOT modeled: silently treating an AC circuit as purely resistive would
 * produce a confidently wrong number, which is the exact failure mode this
 * module exists to prevent. Likewise absent are conductor ampacity, wire
 * gauge, breaker sizing, and voltage-drop limits -- every one of those is a
 * claim against a specific electrical standard (NEC / IEC / BS 7671), and
 * this codebase has no cited, verified source for those tables. See
 * lib/safety/rules/deferred.ts, which makes the same call for the same
 * reason.
 */

/** The four quantities related by Ohm's law and the DC power equations. */
export type ElectricalQuantity = "voltage" | "current" | "resistance" | "power";

/** SI unit symbol for each quantity, for display and for result labeling. */
export const QUANTITY_UNITS: Record<ElectricalQuantity, string> = {
  voltage: "V",
  current: "A",
  resistance: "Ω",
  power: "W",
};

export const QUANTITY_LABELS: Record<ElectricalQuantity, string> = {
  voltage: "Voltage",
  current: "Current",
  resistance: "Resistance",
  power: "Power",
};

/**
 * Known quantities supplied by the caller. Every value must be a real
 * measurement or a previously computed result -- never a model-supplied
 * number. Omitted keys are unknown; `solve` needs exactly two.
 */
export type KnownQuantities = Partial<Record<ElectricalQuantity, number>>;

/**
 * Why a calculation was refused. Each maps to a distinct user-facing
 * message; none of them is ever silently coerced into a number.
 *
 * - `insufficient_inputs`: fewer than two knowns other than the target.
 * - `target_already_known`: the caller passed a value for the quantity it
 *   asked to solve for, which is a caller bug worth surfacing rather than
 *   silently overwriting or silently returning the input unchanged.
 * - `non_finite_input`: NaN or Infinity reached the solver.
 * - `negative_input`: see the sign convention note on `solve`.
 * - `division_by_zero`: a known that appears in a denominator is zero.
 * - `non_finite_result`: inputs were individually valid but the result
 *   overflowed to Infinity (e.g. two near-`Number.MAX_VALUE` operands).
 */
export type CalculationFailureReason =
  | "insufficient_inputs"
  | "target_already_known"
  | "non_finite_input"
  | "negative_input"
  | "division_by_zero"
  | "non_finite_result";

export type CalculationOutcome =
  | {
      ok: true;
      quantity: ElectricalQuantity;
      /** Full double precision. Round only at render time -- see `formatQuantity`. */
      value: number;
      unit: string;
      /** The relationship actually used, e.g. "V = I x R". Safe to show. */
      formula: string;
      /** Which inputs it was derived from, for traceability in the UI. */
      derivedFrom: ElectricalQuantity[];
    }
  | { ok: false; reason: CalculationFailureReason };

/**
 * Each solvable (target, inputs) combination, with the formula used.
 * Exhaustive over the four quantities: any two knowns determine the other
 * two. `compute` receives the two known values in the order named by
 * `inputs`, and `guardZero` names inputs that must be non-zero because they
 * appear in a denominator (or under a division inside a root).
 */
type Relationship = {
  inputs: [ElectricalQuantity, ElectricalQuantity];
  formula: string;
  guardZero: ElectricalQuantity[];
  compute: (a: number, b: number) => number;
};

const RELATIONSHIPS: Record<ElectricalQuantity, Relationship[]> = {
  voltage: [
    {
      inputs: ["current", "resistance"],
      formula: "V = I × R",
      guardZero: [],
      compute: (i, r) => i * r,
    },
    {
      inputs: ["power", "current"],
      formula: "V = P ÷ I",
      guardZero: ["current"],
      compute: (p, i) => p / i,
    },
    {
      inputs: ["power", "resistance"],
      formula: "V = √(P × R)",
      guardZero: [],
      compute: (p, r) => Math.sqrt(p * r),
    },
  ],
  current: [
    {
      inputs: ["voltage", "resistance"],
      formula: "I = V ÷ R",
      guardZero: ["resistance"],
      compute: (v, r) => v / r,
    },
    {
      inputs: ["power", "voltage"],
      formula: "I = P ÷ V",
      guardZero: ["voltage"],
      compute: (p, v) => p / v,
    },
    {
      inputs: ["power", "resistance"],
      formula: "I = √(P ÷ R)",
      guardZero: ["resistance"],
      compute: (p, r) => Math.sqrt(p / r),
    },
  ],
  resistance: [
    {
      inputs: ["voltage", "current"],
      formula: "R = V ÷ I",
      guardZero: ["current"],
      compute: (v, i) => v / i,
    },
    {
      inputs: ["voltage", "power"],
      formula: "R = V² ÷ P",
      guardZero: ["power"],
      compute: (v, p) => (v * v) / p,
    },
    {
      inputs: ["power", "current"],
      formula: "R = P ÷ I²",
      guardZero: ["current"],
      compute: (p, i) => p / (i * i),
    },
  ],
  power: [
    {
      inputs: ["voltage", "current"],
      formula: "P = V × I",
      guardZero: [],
      compute: (v, i) => v * i,
    },
    {
      inputs: ["current", "resistance"],
      formula: "P = I² × R",
      guardZero: [],
      compute: (i, r) => i * i * r,
    },
    {
      inputs: ["voltage", "resistance"],
      formula: "P = V² ÷ R",
      guardZero: ["resistance"],
      compute: (v, r) => (v * v) / r,
    },
  ],
};

/**
 * Solve for `target` from exactly two other known quantities.
 *
 * SIGN CONVENTION: all inputs must be non-negative. A field instrument
 * reports a magnitude, and a negative reading in practice means reversed
 * probes rather than a negative physical quantity. Taking the absolute
 * value silently would be exactly the "misleading number" failure this
 * module exists to avoid, so a negative input is refused and the caller is
 * told why. Zero is accepted wherever it is physically meaningful (0 V
 * across an open contact is a real, useful reading) and refused only where
 * it would be a denominator.
 *
 * Returns an outcome rather than throwing: a refusal is an expected,
 * renderable state in the field, not an exceptional one.
 */
export function solve(
  target: ElectricalQuantity,
  known: KnownQuantities,
): CalculationOutcome {
  if (known[target] !== undefined && known[target] !== null) {
    return { ok: false, reason: "target_already_known" };
  }

  const supplied = (Object.keys(known) as ElectricalQuantity[]).filter(
    (k) => k !== target && known[k] !== undefined && known[k] !== null,
  );

  for (const key of supplied) {
    const value = known[key] as number;
    if (!Number.isFinite(value)) {
      return { ok: false, reason: "non_finite_input" };
    }
    if (value < 0) {
      return { ok: false, reason: "negative_input" };
    }
  }

  // Prefer the first relationship whose inputs are all present. Order
  // within RELATIONSHIPS is therefore meaningful: the most direct form
  // (fewest operations, no root) is listed first so that a caller
  // supplying three knowns gets the least error-prone derivation.
  const relationship = RELATIONSHIPS[target].find((r) =>
    r.inputs.every((input) => supplied.includes(input)),
  );

  if (!relationship) {
    return { ok: false, reason: "insufficient_inputs" };
  }

  for (const guarded of relationship.guardZero) {
    if (known[guarded] === 0) {
      return { ok: false, reason: "division_by_zero" };
    }
  }

  const [firstKey, secondKey] = relationship.inputs;
  const value = relationship.compute(
    known[firstKey] as number,
    known[secondKey] as number,
  );

  // Individually finite inputs can still overflow (or, via 0/0 guarded
  // above, produce NaN). Never hand back a non-finite "result".
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "non_finite_result" };
  }

  return {
    ok: true,
    quantity: target,
    value,
    unit: QUANTITY_UNITS[target],
    formula: relationship.formula,
    derivedFrom: [...relationship.inputs],
  };
}

/**
 * Which quantities can be solved for given what is currently known. Lets a
 * UI enable only the targets that will actually succeed, rather than
 * offering a control that returns `insufficient_inputs` when pressed.
 */
export function solvableTargets(known: KnownQuantities): ElectricalQuantity[] {
  return (Object.keys(QUANTITY_UNITS) as ElectricalQuantity[]).filter(
    (target) => solve(target, known).ok,
  );
}

const FAILURE_MESSAGES: Record<CalculationFailureReason, string> = {
  insufficient_inputs: "Enter two known values to calculate the third.",
  target_already_known: "That value is already known — clear it to recalculate it.",
  non_finite_input: "One of the values entered is not a usable number.",
  negative_input:
    "Enter values as positive magnitudes. A negative reading usually means the probes were reversed.",
  division_by_zero:
    "This calculation would divide by zero. Check the values entered.",
  non_finite_result: "The result is too large to represent accurately.",
};

/** User-facing explanation for a refusal. Never exposes internals. */
export function explainFailure(reason: CalculationFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

/**
 * Render a value for display. Significant-figure based rather than a fixed
 * decimal count, because these quantities span many orders of magnitude in
 * practice -- a 0.0021 A leakage current and a 2400 W load are both
 * ordinary readings, and a fixed 2dp would destroy the former while adding
 * noise to the latter.
 *
 * Rounds only for display; `solve` always returns full precision so that a
 * chained calculation never compounds rounding error.
 */
export function formatQuantity(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "—";

  const magnitude = Math.abs(value);
  let rendered: string;

  if (magnitude === 0) {
    rendered = "0";
  } else if (magnitude >= 1000) {
    rendered = Math.round(value).toLocaleString("en-US");
  } else if (magnitude >= 1) {
    // Trailing zeros carry no information for a derived value.
    rendered = String(Number(value.toFixed(2)));
  } else {
    rendered = String(Number(value.toPrecision(3)));
  }

  return `${rendered} ${unit}`;
}
