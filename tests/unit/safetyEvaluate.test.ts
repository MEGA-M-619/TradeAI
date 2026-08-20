import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASELINE_PRECAUTIONS,
  BASELINE_PRECAUTION_IDS,
  evaluateSafety,
} from "@/lib/safety/evaluate";
import {
  known,
  unknown,
  type MeasurementFact,
  type SafetyFacts,
} from "@/lib/safety/facts";
import {
  FLOOR_STATE,
  RULESET_VERSION,
  SAFETY_STATES,
  STATE_PRECEDENCE,
  type SafetyState,
} from "@/lib/safety/states";
import {
  ACTIVE_RULES,
  DEFERRED_RULES,
  type SafetyRule,
} from "@/lib/safety/rules";

// --- fixtures ---------------------------------------------------------

const CIRCUIT_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

function measurement(
  overrides: Partial<MeasurementFact> & { measurementId: string },
): MeasurementFact {
  return {
    testType: "voltage_ac",
    circuitId: CIRCUIT_ID,
    value: 120,
    unit: "V",
    result: "pass",
    criterion: {
      source: "technician_supplied",
      expectedMin: 114,
      expectedMax: 126,
    },
    recordedAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

/** Facts in which no active rule fires. */
function cleanFacts(measurements?: readonly MeasurementFact[]): SafetyFacts {
  const list = measurements ?? [measurement({ measurementId: "m-1" })];
  return {
    circuit_under_investigation: known({
      circuitId: CIRCUIT_ID,
      label: "Kitchen ring",
    }),
    measurements_on_job: known(list),
    measurements_on_circuit: known(
      list.filter((m) => m.circuitId === CIRCUIT_ID),
    ),
    ai_hazard_categories: known([] as const),
  };
}

const ALL_UNKNOWN: SafetyFacts = {
  circuit_under_investigation: unknown("not_recorded", "no circuit referenced"),
  measurements_on_job: unknown("not_recorded", "nothing recorded"),
  measurements_on_circuit: unknown(
    "depends_on_unknown_fact",
    "circuit not identified",
  ),
  ai_hazard_categories: unknown("not_recorded", "nothing recorded"),
};

/** Test-only rules, injected to exercise states no shipping rule
 * currently produces. Reuses real rule ids so the closed vocabulary is
 * respected. */
function ruleReturning(
  id: SafetyRule["id"],
  state: "STOP" | "INSUFFICIENT_INFORMATION",
  verify = `verify-${id}-${state}`,
): SafetyRule {
  return {
    id,
    requires: [],
    sourceStatus: "no_threshold_required",
    whenUnknown: { message: "unknown", verify: "unknown-verify" },
    evaluate: () => ({
      state,
      message: `${id} reported ${state}`,
      verify,
      measurementIds: [],
      criterionSource: null,
    }),
  };
}

const silentRule: SafetyRule = {
  id: "inconclusive_measurement",
  requires: [],
  sourceStatus: "no_threshold_required",
  whenUnknown: { message: "unknown", verify: "unknown-verify" },
  evaluate: () => null,
};

// --- the floor --------------------------------------------------------

describe("the floor state", () => {
  it("returns the floor when no rule fires, with baseline precautions", () => {
    const result = evaluateSafety(cleanFacts());
    expect(result.state).toBe(FLOOR_STATE);
    expect(result.state).toBe("PROCEED_WITH_PRECAUTIONS");
    expect(result.findings).toEqual([]);
    expect(result.firedRuleIds).toEqual([]);
    expect(result.verifications).toEqual([]);
    expect(result.precautions).toHaveLength(BASELINE_PRECAUTION_IDS.length);
  });

  it("attaches the baseline precautions at every state, not just the floor", () => {
    const scenarios = [
      evaluateSafety(cleanFacts()),
      evaluateSafety(ALL_UNKNOWN),
      evaluateSafety(cleanFacts(), [
        ruleReturning("inconclusive_measurement", "STOP"),
      ]),
    ];
    for (const result of scenarios) {
      expect(result.precautions.map((p) => p.id)).toEqual([
        ...BASELINE_PRECAUTION_IDS,
      ]);
      for (const precaution of result.precautions) {
        expect(precaution.message.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("an empty rule set yields the floor, still with precautions", () => {
    const result = evaluateSafety(cleanFacts(), []);
    expect(result.state).toBe(FLOOR_STATE);
    expect(result.precautions).toHaveLength(BASELINE_PRECAUTION_IDS.length);
  });

  it("does not let a caller mutate the shared precaution constants", () => {
    const result = evaluateSafety(cleanFacts());
    (result.precautions[0] as { message: string }).message = "tampered";
    expect(BASELINE_PRECAUTIONS[0].message).not.toBe("tampered");
    expect(evaluateSafety(cleanFacts()).precautions[0].message).not.toBe(
      "tampered",
    );
  });
});

// --- aggregation ------------------------------------------------------

describe("aggregation", () => {
  it("a single INSUFFICIENT_INFORMATION finding escalates the verdict", () => {
    const result = evaluateSafety(cleanFacts(), [
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
    ]);
    expect(result.state).toBe("INSUFFICIENT_INFORMATION");
    expect(result.firedRuleIds).toEqual(["inconclusive_measurement"]);
  });

  it("multiple findings aggregate by maximum precedence", () => {
    const result = evaluateSafety(cleanFacts(), [
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
      ruleReturning("unevaluated_measurement", "STOP"),
      ruleReturning("no_measurement_on_circuit", "INSUFFICIENT_INFORMATION"),
    ]);
    expect(result.state).toBe("STOP");
    expect(result.findings).toHaveLength(3);
  });

  it("STOP dominates every less restrictive state, in any position", () => {
    const positions: SafetyRule[][] = [
      [
        ruleReturning("unevaluated_measurement", "STOP"),
        ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
      ],
      [
        ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
        ruleReturning("unevaluated_measurement", "STOP"),
      ],
      [
        ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
        ruleReturning("unevaluated_measurement", "STOP"),
        ruleReturning("no_measurement_on_circuit", "INSUFFICIENT_INFORMATION"),
      ],
    ];
    for (const rules of positions) {
      expect(evaluateSafety(cleanFacts(), rules).state).toBe("STOP");
    }
  });

  it("INSUFFICIENT_INFORMATION never dominates STOP", () => {
    const many = Array.from({ length: 20 }, () =>
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
    );
    const result = evaluateSafety(cleanFacts(), [
      ruleReturning("unevaluated_measurement", "STOP"),
      ...many,
    ]);
    expect(result.state).toBe("STOP");
  });

  it("silent rules do not lower a verdict another rule raised", () => {
    const result = evaluateSafety(cleanFacts(), [
      ruleReturning("unevaluated_measurement", "STOP"),
      silentRule,
      silentRule,
    ]);
    expect(result.state).toBe("STOP");
    expect(result.findings).toHaveLength(1);
  });

  it("ratchet property: adding any rule never lowers the result", () => {
    const base: SafetyRule[] = [];
    const candidates: SafetyRule[] = [
      silentRule,
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
      ruleReturning("unevaluated_measurement", "STOP"),
    ];
    let rules = base;
    let previous = STATE_PRECEDENCE[evaluateSafety(cleanFacts(), rules).state];
    for (const candidate of candidates) {
      rules = [...rules, candidate];
      const next = STATE_PRECEDENCE[evaluateSafety(cleanFacts(), rules).state];
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("the verdict dominates every individual finding", () => {
    const rules = [
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
      ruleReturning("unevaluated_measurement", "STOP"),
    ];
    const result = evaluateSafety(cleanFacts(), rules);
    for (const finding of result.findings) {
      expect(STATE_PRECEDENCE[result.state]).toBeGreaterThanOrEqual(
        STATE_PRECEDENCE[finding.state],
      );
    }
  });

  it("rule ordering cannot change the final state", () => {
    const rules = [
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION"),
      ruleReturning("unevaluated_measurement", "STOP"),
      ruleReturning("no_measurement_on_circuit", "INSUFFICIENT_INFORMATION"),
    ];
    const permutations = [
      [rules[0], rules[1], rules[2]],
      [rules[2], rules[1], rules[0]],
      [rules[1], rules[0], rules[2]],
      [rules[2], rules[0], rules[1]],
    ];
    const states = permutations.map((p) => evaluateSafety(cleanFacts(), p).state);
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toBe("STOP");
  });
});

// --- returned metadata ------------------------------------------------

describe("returned metadata", () => {
  it("returns the ruleset version from the state model", () => {
    expect(evaluateSafety(cleanFacts()).rulesetVersion).toBe(RULESET_VERSION);
    expect(evaluateSafety(ALL_UNKNOWN).rulesetVersion).toBe(RULESET_VERSION);
  });

  it("returns fired rule ids deterministically, in registry order", () => {
    const result = evaluateSafety(ALL_UNKNOWN);
    expect(result.firedRuleIds).toEqual(
      result.findings.map((finding) => finding.ruleId),
    );
    for (let i = 0; i < 10; i += 1) {
      expect(evaluateSafety(ALL_UNKNOWN).firedRuleIds).toEqual(
        result.firedRuleIds,
      );
    }
  });

  it("returns verification requirements deterministically", () => {
    const result = evaluateSafety(ALL_UNKNOWN);
    expect(result.verifications.length).toBeGreaterThan(0);
    for (const verification of result.verifications) {
      expect(verification.trim().length).toBeGreaterThan(0);
    }
    for (let i = 0; i < 10; i += 1) {
      expect(evaluateSafety(ALL_UNKNOWN).verifications).toEqual(
        result.verifications,
      );
    }
  });

  it("de-duplicates identical verifications, preserving first-occurrence order", () => {
    const shared = "do the same thing";
    const result = evaluateSafety(cleanFacts(), [
      ruleReturning("inconclusive_measurement", "INSUFFICIENT_INFORMATION", shared),
      ruleReturning("unevaluated_measurement", "INSUFFICIENT_INFORMATION", "second"),
      ruleReturning("no_measurement_on_circuit", "INSUFFICIENT_INFORMATION", shared),
    ]);
    expect(result.findings).toHaveLength(3);
    expect(result.verifications).toEqual([shared, "second"]);
  });

  it("preserves each finding's basis and criterionSource", () => {
    const contradiction = cleanFacts([
      measurement({ measurementId: "m-a", result: "pass" }),
      measurement({ measurementId: "m-b", result: "fail" }),
    ]);
    const result = evaluateSafety(contradiction);
    const finding = result.findings.find(
      (f) => f.ruleId === "contradictory_measurement_results",
    );
    expect(finding).toBeDefined();
    expect(finding?.basis.criterionSource).toBe("technician_supplied");
    expect(finding?.basis.measurementIds).toEqual(["m-a", "m-b"]);
    expect(finding?.basis.factsUsed).toContain("measurements_on_job");
  });

  it("keeps unknown facts distinguishable from known ones in the result", () => {
    const partial = {
      ...cleanFacts(),
      measurements_on_job: unknown("ambiguous", "two conflicting sources"),
    } satisfies SafetyFacts;

    expect(evaluateSafety(partial).unknownFacts).toEqual([
      "measurements_on_job",
    ]);
    expect(evaluateSafety(cleanFacts()).unknownFacts).toEqual([]);
    expect(evaluateSafety(ALL_UNKNOWN).unknownFacts).toEqual([
      "circuit_under_investigation",
      "measurements_on_job",
      "measurements_on_circuit",
      "ai_hazard_categories",
    ]);
  });

  it("records the unknown reason on findings produced by a missing fact", () => {
    const result = evaluateSafety(ALL_UNKNOWN);
    const withReason = result.findings.filter(
      (f) => f.basis.unknownReason !== null,
    );
    expect(withReason.length).toBeGreaterThan(0);
    for (const finding of withReason) {
      expect(["not_recorded", "ambiguous", "depends_on_unknown_fact"]).toContain(
        finding.basis.unknownReason,
      );
    }
  });
});

// --- safety invariants ------------------------------------------------

describe("safety invariants", () => {
  it("never produces a SAFE / all-clear / code-compliant state", () => {
    const scenarios: SafetyFacts[] = [
      cleanFacts(),
      ALL_UNKNOWN,
      cleanFacts([measurement({ measurementId: "m-1", result: "inconclusive" })]),
      cleanFacts([measurement({ measurementId: "m-1", result: null })]),
    ];
    const permissive = /^(safe|all[_ -]?clear|code[_ -]?compliant|ok(ay)?|pass(ed)?)$/i;
    for (const facts of scenarios) {
      const result = evaluateSafety(facts);
      expect(SAFETY_STATES).toContain(result.state);
      expect(result.state).not.toMatch(permissive);
    }
    expect(SAFETY_STATES).not.toContain("SAFE" as unknown as SafetyState);
  });

  it("never claims anything is safe, de-energized, or compliant", () => {
    // Every string the evaluator can emit, across every scenario.
    const scenarios: SafetyFacts[] = [cleanFacts(), ALL_UNKNOWN];
    for (const facts of scenarios) {
      const result = evaluateSafety(facts);
      const emitted = [
        ...result.precautions.map((p) => p.message),
        ...result.findings.map((f) => f.message),
        ...result.verifications,
      ];
      for (const text of emitted) {
        expect(text).not.toMatch(/\bis safe\b/i);
        expect(text).not.toMatch(/\bsafe to (touch|energi[sz]e|work)\b/i);
        expect(text).not.toMatch(/\ball clear\b/i);
        expect(text).not.toMatch(/\bis (code[- ])?compliant\b/i);
        expect(text).not.toMatch(/\bis de-?energi[sz]ed\b/i);
        expect(text).not.toMatch(/\bconfirmed de-?energi[sz]ed\b/i);
      }
    }
  });

  it("a passing measurement creates no permissive claim", () => {
    const passing = cleanFacts([
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-2", result: "pass" }),
    ]);
    const result = evaluateSafety(passing);
    // Silence from the rules, but the floor is not a certification: the
    // precautions still attach and nothing asserts safety.
    expect(result.state).toBe(FLOOR_STATE);
    expect(result.precautions).toHaveLength(BASELINE_PRECAUTION_IDS.length);
    expect(result.findings).toEqual([]);
  });

  it("a fabricated technician range cannot manufacture a permissive verdict", () => {
    const fabricated = cleanFacts([
      measurement({
        measurementId: "m-1",
        value: 0,
        result: "pass",
        criterion: {
          source: "technician_supplied",
          expectedMin: -1_000_000,
          expectedMax: 1_000_000,
        },
      }),
    ]);
    const result = evaluateSafety(fabricated);
    // The best it can buy is silence, and silence is the floor -- which
    // carries mandatory precautions and asserts nothing.
    expect(result.state).toBe(FLOOR_STATE);
    expect(result.precautions).toHaveLength(BASELINE_PRECAUTION_IDS.length);
    expect(SAFETY_STATES).not.toContain("SAFE" as unknown as SafetyState);
  });

  it("a failing measurement does not automatically become STOP", () => {
    const failing = cleanFacts([
      measurement({ measurementId: "m-1", result: "fail" }),
    ]);
    expect(evaluateSafety(failing).state).not.toBe("STOP");
  });

  it("contradictory measurements remain INSUFFICIENT_INFORMATION", () => {
    const contradictory = cleanFacts([
      measurement({ measurementId: "m-a", result: "pass" }),
      measurement({ measurementId: "m-b", result: "fail" }),
    ]);
    const result = evaluateSafety(contradictory);
    expect(result.state).toBe("INSUFFICIENT_INFORMATION");
    expect(result.firedRuleIds).toContain("contradictory_measurement_results");
  });

  it("inconclusive and not_applicable are not treated as pass", () => {
    for (const result of ["inconclusive", "not_applicable", null] as const) {
      const facts = cleanFacts([measurement({ measurementId: "m-1", result })]);
      expect(evaluateSafety(facts).state).toBe("INSUFFICIENT_INFORMATION");
    }
  });

  it("no shipping rule produces STOP today, and none is manufactured", () => {
    // Honest current state: the threshold-free rule set tops out at
    // INSUFFICIENT_INFORMATION. If this ever changes it should be a
    // deliberate, reviewed act, not a silent drift.
    const scenarios: SafetyFacts[] = [
      cleanFacts(),
      ALL_UNKNOWN,
      cleanFacts([measurement({ measurementId: "m-1", result: "fail" })]),
      cleanFacts([measurement({ measurementId: "m-1", result: "inconclusive" })]),
      cleanFacts([measurement({ measurementId: "m-1", result: null })]),
      cleanFacts([
        measurement({ measurementId: "m-a", result: "pass" }),
        measurement({ measurementId: "m-b", result: "fail" }),
      ]),
    ];
    for (const facts of scenarios) {
      expect(evaluateSafety(facts).state).not.toBe("STOP");
    }
  });

  it("the deferred standards-dependent rule stays out of the evaluation", () => {
    const deferredIds = new Set(DEFERRED_RULES.map((r) => r.id));
    for (const facts of [cleanFacts(), ALL_UNKNOWN]) {
      for (const id of evaluateSafety(facts).firedRuleIds) {
        expect(deferredIds.has(id)).toBe(false);
      }
    }
    const activeIds = new Set(ACTIVE_RULES.map((r) => r.id));
    for (const id of deferredIds) {
      expect(activeIds.has(id)).toBe(false);
    }
  });
});

// --- determinism ------------------------------------------------------

describe("determinism", () => {
  it("identical facts produce byte-equivalent results", () => {
    const facts = cleanFacts([
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-3", result: "inconclusive" }),
    ]);
    const first = JSON.stringify(evaluateSafety(facts));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(evaluateSafety(facts))).toBe(first);
    }
  });

  it("reordering measurements produces the same logical result", () => {
    const a = cleanFacts([
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-3", result: "inconclusive" }),
    ]);
    const b = cleanFacts([
      measurement({ measurementId: "m-3", result: "inconclusive" }),
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-1", result: "pass" }),
    ]);
    expect(JSON.stringify(evaluateSafety(a))).toBe(
      JSON.stringify(evaluateSafety(b)),
    );
  });

  it("does not depend on the clock", async () => {
    const facts = cleanFacts([
      measurement({ measurementId: "m-1", result: "inconclusive" }),
    ]);
    const before = JSON.stringify(evaluateSafety(facts));
    await new Promise((r) => setTimeout(r, 25));
    expect(JSON.stringify(evaluateSafety(facts))).toBe(before);
  });

  it("the whole result is JSON-serializable and round-trips unchanged", () => {
    const result = evaluateSafety(ALL_UNKNOWN);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("does not mutate the facts it is given", () => {
    const facts = cleanFacts([
      measurement({ measurementId: "m-1", result: "inconclusive" }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(facts));
    evaluateSafety(facts);
    expect(JSON.parse(JSON.stringify(facts))).toEqual(snapshot);
  });
});

// --- architectural boundaries ----------------------------------------

describe("architectural boundaries", () => {
  const source = readFileSync(
    resolve(process.cwd(), "lib/safety/evaluate.ts"),
    "utf8",
  );
  const code = source.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");

  it("imports no database, repository, route, or Supabase module", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/db\//);
    expect(code).not.toMatch(/from\s+["']@\/lib\/generated\//);
    expect(code).not.toMatch(/@prisma\//);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/repositor/i);
    expect(code).not.toMatch(/from\s+["']@\/app\//);
  });

  it("imports no AI or model module", () => {
    expect(code).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(code).not.toMatch(/anthropic/i);
    expect(code).not.toMatch(/openai/i);
    expect(code).not.toMatch(/\bllm\b/i);
    expect(code).not.toMatch(/modelFactory|AssessmentModel/);
  });

  it("performs no downgrade operation", () => {
    expect(code).not.toMatch(/\bminState\b/);
    expect(code).not.toMatch(/\bMath\.min\b/);
    expect(code).not.toMatch(/downgrade|relax|clearState|lowerState/i);
  });

  it("aggregates only through the lattice helper", () => {
    expect(code).toMatch(/aggregateSafetyStates\(/);
  });

  it("mutates no diagnostic state and writes nothing", () => {
    expect(code).not.toMatch(/\.update\(|\.create\(|\.delete\(|\.upsert\(/);
    expect(code).not.toMatch(/diagnosticCause|diagnosticSession/i);
  });

  it("contains no electrical threshold or standard reference", () => {
    expect(code).not.toMatch(/\bNEC\b|\bIEC\b|BS\s?7671|NFPA/);
    expect(code).not.toMatch(/\.value\s*[<>]=?/);
  });
});
