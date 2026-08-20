import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVE_RULES,
  ALL_RULES,
  DEFERRED_RULES,
  DeferredRuleInvokedError,
  InvalidRuleOutcomeError,
  RULE_SOURCE_STATUSES,
  SAFETY_RULE_IDS,
  VERIFIED_CRITERION_SOURCES,
  applyActiveRules,
  applySafetyRule,
  getRuleById,
  isRuleSourceStatus,
  isSafetyRuleId,
  ruleSourceProblems,
  summariseCriterionSource,
  type RuleSource,
  type SafetyRule,
} from "@/lib/safety/rules";
import {
  known,
  unknown,
  type MeasurementFact,
  type SafetyFacts,
} from "@/lib/safety/facts";
import {
  FLOOR_STATE,
  SAFETY_STATES,
  STATE_PRECEDENCE,
  aggregateSafetyStates,
  isSafetyState,
} from "@/lib/safety/states";

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

/** A fact set in which no rule fires: circuit known, a measurement on it,
 * and every measurement definitively evaluated. */
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

function factsWith(overrides: Partial<SafetyFacts>): SafetyFacts {
  return { ...cleanFacts(), ...overrides };
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

// --- registry ---------------------------------------------------------

describe("registry integrity", () => {
  it("every active rule has an id from the closed vocabulary", () => {
    for (const rule of ACTIVE_RULES) {
      expect(isSafetyRuleId(rule.id)).toBe(true);
    }
  });

  it("is exhaustive: every declared rule id is implemented exactly once", () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(ids.sort()).toEqual([...SAFETY_RULE_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of SAFETY_RULE_IDS) {
      expect(getRuleById(id)).toBeDefined();
    }
  });

  it("declares the approved active rules, measurement rules first", () => {
    expect(ACTIVE_RULES.map((r) => r.id)).toEqual([
      "circuit_not_uniquely_identified",
      "no_measurement_on_circuit",
      "contradictory_measurement_results",
      "inconclusive_measurement",
      "unevaluated_measurement",
      "ai_hazard_arc_fault_suspected",
      "ai_hazard_water_ingress_energized",
      "ai_hazard_thermal_damage_scorching",
      "ai_hazard_backfed_or_double_lugged_neutral",
      "ai_hazard_missing_bonding_or_grounding",
      "ai_hazard_aluminium_branch_conductors",
      "ai_hazard_recalled_panel_brand",
      "ai_hazard_knob_and_tube_or_asbestos_era",
    ]);
  });

  it("rejects arbitrary strings as rule ids", () => {
    for (const bad of ["", "STOP", "circuit_not_uniquely_identified ", null, 0]) {
      expect(isSafetyRuleId(bad)).toBe(false);
    }
  });

  it("every active rule declares at least one required fact, all valid keys", () => {
    for (const rule of ACTIVE_RULES) {
      expect(rule.requires.length).toBeGreaterThan(0);
      for (const key of rule.requires) {
        expect([
          "circuit_under_investigation",
          "measurements_on_job",
          "measurements_on_circuit",
          "ai_hazard_categories",
        ]).toContain(key);
      }
    }
  });

  it("every active rule carries non-empty constant text for its unknown case", () => {
    for (const rule of ACTIVE_RULES) {
      expect(rule.whenUnknown.message.trim().length).toBeGreaterThan(0);
      expect(rule.whenUnknown.verify.trim().length).toBeGreaterThan(0);
    }
  });

  it("every message a rule can emit is non-empty", () => {
    // Drive each rule into its firing state and check the emitted text.
    const findings = applyActiveRules(ALL_UNKNOWN);
    for (const finding of findings) {
      expect(finding.message.trim().length).toBeGreaterThan(0);
      expect(finding.verify.trim().length).toBeGreaterThan(0);
    }
    expect(findings.length).toBeGreaterThan(0);
  });

  it("source statuses come from the closed vocabulary", () => {
    for (const rule of ALL_RULES) {
      expect(isRuleSourceStatus(rule.sourceStatus)).toBe(true);
    }
    expect([...RULE_SOURCE_STATUSES]).toEqual([
      "no_threshold_required",
      "requires_verified_source",
      "verified",
    ]);
  });
});

// --- the standards guard ---------------------------------------------

describe("standards guard", () => {
  it("no active rule requires an unverified electrical standard", () => {
    for (const rule of ACTIVE_RULES) {
      expect(rule.sourceStatus).toBe("no_threshold_required");
    }
  });

  it("no rule marked requires_verified_source appears in ACTIVE_RULES", () => {
    const activeIds = new Set(ACTIVE_RULES.map((r) => r.id));
    for (const deferred of DEFERRED_RULES) {
      expect(deferred.sourceStatus).toBe("requires_verified_source");
      expect(activeIds.has(deferred.id)).toBe(false);
    }
  });

  it("no rule ships a citation today, because no standard has been verified", () => {
    for (const rule of ALL_RULES) {
      expect(rule.source, `${rule.id} carries a source`).toBeUndefined();
      expect(rule.sourceStatus).not.toBe("verified");
    }
  });

  it("every rule's citation is coherent with its claimed status", () => {
    for (const rule of ALL_RULES) {
      expect(ruleSourceProblems(rule), rule.id).toEqual([]);
    }
  });

  it("`verified` cannot be claimed without a citation", () => {
    const problems = ruleSourceProblems({
      id: "pretend_rule",
      sourceStatus: "verified",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/carries no source/);
  });

  it("`verified` cannot be claimed with an incomplete citation", () => {
    for (const missing of ["standard", "edition", "clause"] as const) {
      const source = {
        standard: "S",
        edition: "E",
        clause: "C",
        [missing]: "",
      } as RuleSource;
      const problems = ruleSourceProblems({
        id: "pretend_rule",
        sourceStatus: "verified",
        source,
      });
      expect(problems, `missing ${missing}`).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`source\\.${missing} is empty`));
    }
  });

  it("a blank-but-present citation part is treated as missing", () => {
    // Whitespace is not a citation.
    for (const blank of ["   ", "\t", "\n"]) {
      const problems = ruleSourceProblems({
        id: "pretend_rule",
        sourceStatus: "verified",
        source: { standard: blank, edition: "E", clause: "C" },
      });
      expect(problems).toHaveLength(1);
    }
  });

  it("names every missing citation part, not just the first", () => {
    const problems = ruleSourceProblems({
      id: "pretend_rule",
      sourceStatus: "verified",
      source: { standard: "", edition: "", clause: "" },
    });
    expect(problems).toHaveLength(3);
  });

  it("a citation cannot be attached without claiming `verified`", () => {
    // The other half of the biconditional: a rule that looks cited but
    // is not marked verified would slip past the status-based guard.
    for (const status of [
      "no_threshold_required",
      "requires_verified_source",
    ] as const) {
      const problems = ruleSourceProblems({
        id: "pretend_rule",
        sourceStatus: status,
        source: { standard: "S", edition: "E", clause: "C" },
      });
      expect(problems, status).toHaveLength(1);
      expect(problems[0]).toMatch(/not "verified"/);
    }
  });

  it("accepts a complete citation on a verified rule", () => {
    // The shape a future cited rule must satisfy. Deliberately uses
    // placeholder text rather than a real standard: this asserts the
    // guard's shape, and inventing a citation here would be exactly the
    // failure the guard exists to prevent.
    expect(
      ruleSourceProblems({
        id: "pretend_rule",
        sourceStatus: "verified",
        source: {
          standard: "<standard identifier>",
          edition: "<edition>",
          clause: "<clause>",
        },
      }),
    ).toEqual([]);
  });

  it("activating a deferred rule would fail loudly rather than silently", () => {
    // Guards against a future edit that moves a deferred rule into
    // ACTIVE_RULES without supplying the source.
    for (const deferred of DEFERRED_RULES) {
      expect(() => deferred.evaluate(cleanFacts())).toThrow(
        DeferredRuleInvokedError,
      );
    }
  });

  it("recognises no criterion source as verified, because none exists yet", () => {
    expect([...VERIFIED_CRITERION_SOURCES]).toEqual([]);
  });

  it("no rule source file contains a standard name or a numeric limit", () => {
    const dir = resolve(process.cwd(), "lib/safety/rules");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(resolve(dir, file), "utf8");
      const code = source.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");
      expect(code, `${file} names a standard`).not.toMatch(
        /\bNEC\b|\bIEC\b|BS\s?7671|NFPA|\bIET\b/,
      );
      // No comparison of a measured magnitude against a literal number.
      expect(code, `${file} compares a magnitude`).not.toMatch(
        /\.value\s*[<>]=?/,
      );
      expect(code, `${file} compares a magnitude`).not.toMatch(
        /expected(Min|Max)\s*[<>]=?\s*\d/,
      );
    }
  });
});

// --- missing facts escalate ------------------------------------------

describe("a missing required fact escalates, never abstains", () => {
  it("every active rule escalates when each of its required facts is Unknown", () => {
    for (const rule of ACTIVE_RULES) {
      for (const key of rule.requires) {
        const facts = factsWith({
          [key]: unknown("not_recorded", `${key} deliberately withheld`),
        } as Partial<SafetyFacts>);

        const finding = applySafetyRule(rule, facts);
        expect(finding, `${rule.id} abstained on missing ${key}`).not.toBeNull();
        expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
        expect(finding?.state).not.toBe(FLOOR_STATE);
      }
    }
  });

  it("records which fact was unknown and why", () => {
    const facts = factsWith({
      measurements_on_job: unknown("ambiguous", "two conflicting sources"),
    });
    const finding = applySafetyRule(
      ACTIVE_RULES.find((r) => r.id === "inconclusive_measurement")!,
      facts,
    );
    expect(finding?.basis.unknownReason).toBe("ambiguous");
    expect(finding?.basis.factsUsed).toContain("measurements_on_job");
  });

  it("never calls a rule's predicate when a required fact is missing", () => {
    let called = false;
    const probe: SafetyRule = {
      id: "no_measurement_on_circuit",
      requires: ["measurements_on_circuit"],
      sourceStatus: "no_threshold_required",
      whenUnknown: { message: "unknown", verify: "verify" },
      evaluate: () => {
        called = true;
        return null;
      },
    };
    applySafetyRule(probe, ALL_UNKNOWN);
    expect(called).toBe(false);
  });

  it("all-unknown facts escalate every active rule", () => {
    const findings = applyActiveRules(ALL_UNKNOWN);
    expect(findings).toHaveLength(ACTIVE_RULES.length);
    for (const finding of findings) {
      expect(finding.state).toBe("INSUFFICIENT_INFORMATION");
    }
  });
});

// --- individual rule behaviour ---------------------------------------

describe("circuit_not_uniquely_identified", () => {
  const rule = () =>
    ACTIVE_RULES.find((r) => r.id === "circuit_not_uniquely_identified")!;

  it("escalates when the circuit is not recorded", () => {
    const finding = applySafetyRule(
      rule(),
      factsWith({
        circuit_under_investigation: unknown(
          "not_recorded",
          "no measurement references a circuit",
        ),
      }),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.unknownReason).toBe("not_recorded");
  });

  it("escalates when the circuit is ambiguous", () => {
    const finding = applySafetyRule(
      rule(),
      factsWith({
        circuit_under_investigation: unknown(
          "ambiguous",
          "measurements reference three circuits",
        ),
      }),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.unknownReason).toBe("ambiguous");
  });

  it("says nothing once the circuit is identified", () => {
    expect(applySafetyRule(rule(), cleanFacts())).toBeNull();
  });
});

describe("no_measurement_on_circuit", () => {
  const rule = () =>
    ACTIVE_RULES.find((r) => r.id === "no_measurement_on_circuit")!;

  it("escalates on Known([]) -- we looked and found none", () => {
    const finding = applySafetyRule(
      rule(),
      factsWith({ measurements_on_circuit: known([] as MeasurementFact[]) }),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.unknownReason).toBeNull();
    expect(finding?.basis.measurementIds).toEqual([]);
  });

  it("escalates on Unknown, by the missing-fact path, with a reason", () => {
    const finding = applySafetyRule(
      rule(),
      factsWith({
        measurements_on_circuit: unknown(
          "depends_on_unknown_fact",
          "circuit not identified",
        ),
      }),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.unknownReason).toBe("depends_on_unknown_fact");
  });

  it("distinguishes the empty case from the unknown case in its message", () => {
    const empty = applySafetyRule(
      rule(),
      factsWith({ measurements_on_circuit: known([] as MeasurementFact[]) }),
    );
    const unknownCase = applySafetyRule(
      rule(),
      factsWith({
        measurements_on_circuit: unknown("not_recorded", "not established"),
      }),
    );
    expect(empty?.message).not.toBe(unknownCase?.message);
  });

  it("says nothing when a measurement exists", () => {
    expect(applySafetyRule(rule(), cleanFacts())).toBeNull();
  });
});

describe("contradictory_measurement_results", () => {
  const rule = () =>
    ACTIVE_RULES.find((r) => r.id === "contradictory_measurement_results")!;

  const conflicting = [
    measurement({ measurementId: "m-b", result: "pass" }),
    measurement({ measurementId: "m-a", result: "fail" }),
  ];

  it("escalates when pass and fail disagree on the same circuit and test type", () => {
    const finding = applySafetyRule(rule(), cleanFacts(conflicting));
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.measurementIds).toEqual(["m-a", "m-b"]);
  });

  it("never resolves the contradiction by preferring one reading", () => {
    // The most recent, the most favourable, and the average are all
    // fabrications; the rule must decline all three.
    const withTimes = [
      measurement({
        measurementId: "old",
        result: "fail",
        recordedAt: "2026-08-19T09:00:00.000Z",
      }),
      measurement({
        measurementId: "new",
        result: "pass",
        recordedAt: "2026-08-19T17:00:00.000Z",
      }),
    ];
    const finding = applySafetyRule(rule(), cleanFacts(withTimes));
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.measurementIds).toEqual(["new", "old"]);
  });

  it("does not fire across different test types", () => {
    const different = [
      measurement({ measurementId: "m-1", testType: "voltage_ac", result: "pass" }),
      measurement({
        measurementId: "m-2",
        testType: "continuity",
        unit: "Ω",
        result: "fail",
      }),
    ];
    expect(applySafetyRule(rule(), cleanFacts(different))).toBeNull();
  });

  it("does not fire across different circuits", () => {
    const different = [
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({
        measurementId: "m-2",
        circuitId: "11111111-1111-4111-8111-111111111111",
        result: "fail",
      }),
    ];
    expect(applySafetyRule(rule(), cleanFacts(different))).toBeNull();
  });

  it("still fires for two unattributed readings of the same type", () => {
    const unattributed = [
      measurement({ measurementId: "m-1", circuitId: null, result: "pass" }),
      measurement({ measurementId: "m-2", circuitId: null, result: "fail" }),
    ];
    const facts: SafetyFacts = {
      circuit_under_investigation: known({
        circuitId: CIRCUIT_ID,
        label: "Kitchen ring",
      }),
      measurements_on_job: known(unattributed),
      measurements_on_circuit: known([measurement({ measurementId: "m-3" })]),
      ai_hazard_categories: known([] as const),
    };
    expect(applySafetyRule(rule(), facts)?.state).toBe(
      "INSUFFICIENT_INFORMATION",
    );
  });

  it("says nothing when all results agree", () => {
    expect(applySafetyRule(rule(), cleanFacts())).toBeNull();
  });

  it("records the criterion the conflicting readings rested on", () => {
    const finding = applySafetyRule(rule(), cleanFacts(conflicting));
    expect(finding?.basis.criterionSource).toBe("technician_supplied");
  });
});

describe("inconclusive_measurement", () => {
  const rule = () =>
    ACTIVE_RULES.find((r) => r.id === "inconclusive_measurement")!;

  it("escalates on an inconclusive reading", () => {
    const finding = applySafetyRule(
      rule(),
      cleanFacts([measurement({ measurementId: "m-1", result: "inconclusive" })]),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.measurementIds).toEqual(["m-1"]);
  });

  it("lists every inconclusive reading, sorted", () => {
    const finding = applySafetyRule(
      rule(),
      cleanFacts([
        measurement({ measurementId: "m-z", result: "inconclusive" }),
        measurement({ measurementId: "m-a", result: "inconclusive" }),
        measurement({ measurementId: "m-ok", result: "pass" }),
      ]),
    );
    expect(finding?.basis.measurementIds).toEqual(["m-a", "m-z"]);
  });

  it("says nothing when every reading is definite", () => {
    expect(applySafetyRule(rule(), cleanFacts())).toBeNull();
  });
});

describe("unevaluated_measurement", () => {
  const rule = () =>
    ACTIVE_RULES.find((r) => r.id === "unevaluated_measurement")!;

  it("escalates when a reading has no criterion (not_applicable)", () => {
    const finding = applySafetyRule(
      rule(),
      cleanFacts([
        measurement({
          measurementId: "m-1",
          result: "not_applicable",
          criterion: { source: "none" },
        }),
      ]),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.criterionSource).toBe("none");
  });

  it("escalates on a null result -- never treats it as fine", () => {
    // Rows predating the Phase 3B wiring have no computed result.
    const finding = applySafetyRule(
      rule(),
      cleanFacts([measurement({ measurementId: "m-1", result: null })]),
    );
    expect(finding?.state).toBe("INSUFFICIENT_INFORMATION");
    expect(finding?.basis.measurementIds).toEqual(["m-1"]);
  });

  it("says nothing when every reading was evaluated", () => {
    expect(applySafetyRule(rule(), cleanFacts())).toBeNull();
  });
});

// --- the safety invariants -------------------------------------------

describe("safety invariants", () => {
  it("no rule can produce the floor state", () => {
    const scenarios: SafetyFacts[] = [
      cleanFacts(),
      ALL_UNKNOWN,
      cleanFacts([measurement({ measurementId: "m-1", result: "inconclusive" })]),
      cleanFacts([measurement({ measurementId: "m-1", result: null })]),
      cleanFacts([
        measurement({ measurementId: "m-1", result: "pass" }),
        measurement({ measurementId: "m-2", result: "fail" }),
      ]),
      factsWith({ measurements_on_circuit: known([] as MeasurementFact[]) }),
    ];
    for (const facts of scenarios) {
      for (const finding of applyActiveRules(facts)) {
        expect(finding.state).not.toBe(FLOOR_STATE);
        expect(finding.state).not.toBe("PROCEED_WITH_PRECAUTIONS");
      }
    }
  });

  it("no rule emits a permissive or SAFE-equivalent state", () => {
    const permissive = /^(safe|all[_ -]?clear|pass(ed)?|ok(ay)?|clear|permitted)$/i;
    for (const facts of [cleanFacts(), ALL_UNKNOWN]) {
      for (const finding of applyActiveRules(facts)) {
        expect(isSafetyState(finding.state)).toBe(true);
        expect(finding.state).not.toMatch(permissive);
      }
    }
  });

  it("a rule outcome can only ever raise the aggregate, never lower it", () => {
    // Rules emit escalated states only, so folding them in cannot reduce
    // whatever was already held.
    for (const held of SAFETY_STATES) {
      for (const finding of applyActiveRules(ALL_UNKNOWN)) {
        const combined = aggregateSafetyStates([held, finding.state]);
        expect(STATE_PRECEDENCE[combined]).toBeGreaterThanOrEqual(
          STATE_PRECEDENCE[held],
        );
      }
    }
  });

  it("a rule returning the floor state is rejected at runtime", () => {
    const rogue = {
      id: "inconclusive_measurement",
      requires: ["measurements_on_job"],
      sourceStatus: "no_threshold_required",
      whenUnknown: { message: "m", verify: "v" },
      evaluate: () => ({
        state: "PROCEED_WITH_PRECAUTIONS",
        message: "all good",
        verify: "nothing",
      }),
    } as unknown as SafetyRule;
    expect(() => applySafetyRule(rogue, cleanFacts())).toThrow(
      InvalidRuleOutcomeError,
    );
  });

  it("a fabricated technician range cannot produce a permissive verdict", () => {
    // A caller can post any expectedMin/expectedMax and manufacture a
    // `pass` (lib/validation/measurement.ts takes them from the request
    // body). What that buys them is silence from the rules -- and silence
    // is not a certification: the engine has no permissive state to
    // reach, and the criterion it rested on is recorded as unverified.
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
    const findings = applyActiveRules(fabricated);
    for (const finding of findings) {
      expect(finding.state).not.toBe(FLOOR_STATE);
    }
    // No SAFE-equivalent state exists anywhere for it to reach.
    expect(SAFETY_STATES).not.toContain("SAFE");
    expect(
      summariseCriterionSource([measurement({ measurementId: "m-1" })]),
    ).toBe("technician_supplied");
  });

  it("`pass` is never treated as evidence that anything is safe", () => {
    // The only rule that consults `pass` at all is the contradiction
    // rule, and only to notice it conflicts with a `fail`.
    const passing = cleanFacts([
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-2", result: "pass" }),
    ]);
    for (const finding of applyActiveRules(passing)) {
      expect(finding.message).not.toMatch(/\bsafe\b/i);
      expect(finding.verify).not.toMatch(/\bis safe\b/i);
    }
  });

  it("`fail` does not by itself produce STOP", () => {
    const failing = cleanFacts([
      measurement({ measurementId: "m-1", result: "fail" }),
    ]);
    for (const finding of applyActiveRules(failing)) {
      expect(finding.state).not.toBe("STOP");
    }
  });
});

// --- determinism and boundaries --------------------------------------

describe("determinism", () => {
  it("identical facts produce identical findings, every time", () => {
    const facts = cleanFacts([
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-3", result: "inconclusive" }),
    ]);
    const first = JSON.stringify(applyActiveRules(facts));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(applyActiveRules(facts))).toBe(first);
    }
  });

  it("findings are serializable and round-trip unchanged", () => {
    const findings = applyActiveRules(ALL_UNKNOWN);
    expect(JSON.parse(JSON.stringify(findings))).toEqual(findings);
  });

  it("does not mutate the facts it is given", () => {
    const facts = cleanFacts([
      measurement({ measurementId: "m-1", result: "inconclusive" }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(facts));
    applyActiveRules(facts);
    expect(JSON.parse(JSON.stringify(facts))).toEqual(snapshot);
  });

  it("measurement id ordering does not change the outcome", () => {
    const a = cleanFacts([
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-2", result: "fail" }),
    ]);
    const b = cleanFacts([
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-1", result: "pass" }),
    ]);
    expect(JSON.stringify(applyActiveRules(a))).toBe(
      JSON.stringify(applyActiveRules(b)),
    );
  });
});

describe("boundary cases", () => {
  it("an empty measurement set on a known circuit still escalates", () => {
    const facts: SafetyFacts = {
      circuit_under_investigation: known({
        circuitId: CIRCUIT_ID,
        label: "Kitchen ring",
      }),
      measurements_on_job: known([] as MeasurementFact[]),
      measurements_on_circuit: known([] as MeasurementFact[]),
      ai_hazard_categories: known([] as const),
    };
    const findings = applyActiveRules(facts);
    expect(findings.map((f) => f.ruleId)).toContain("no_measurement_on_circuit");
    for (const finding of findings) {
      expect(finding.state).toBe("INSUFFICIENT_INFORMATION");
    }
  });

  it("many measurements are handled without changing the verdict shape", () => {
    const many = Array.from({ length: 200 }, (_unused, i) =>
      measurement({ measurementId: `m-${String(i).padStart(3, "0")}` }),
    );
    const findings = applyActiveRules(cleanFacts(many));
    expect(findings).toEqual([]);
  });

  it("one bad reading among many still escalates", () => {
    const many = Array.from({ length: 50 }, (_unused, i) =>
      measurement({ measurementId: `m-${String(i).padStart(3, "0")}` }),
    );
    const withBad = [
      ...many,
      measurement({ measurementId: "m-bad", result: "inconclusive" }),
    ];
    const findings = applyActiveRules(cleanFacts(withBad));
    expect(findings.map((f) => f.ruleId)).toEqual(["inconclusive_measurement"]);
    expect(findings[0].basis.measurementIds).toEqual(["m-bad"]);
  });

  it("multiple distinct problems each produce their own finding", () => {
    const messy = cleanFacts([
      measurement({ measurementId: "m-1", result: "pass" }),
      measurement({ measurementId: "m-2", result: "fail" }),
      measurement({ measurementId: "m-3", result: "inconclusive" }),
      measurement({ measurementId: "m-4", result: null }),
    ]);
    const ids = applyActiveRules(messy).map((f) => f.ruleId);
    expect(ids).toContain("contradictory_measurement_results");
    expect(ids).toContain("inconclusive_measurement");
    expect(ids).toContain("unevaluated_measurement");
  });

  it("summariseCriterionSource reports mixed sources honestly", () => {
    expect(summariseCriterionSource([])).toBeNull();
    expect(
      summariseCriterionSource([measurement({ measurementId: "m-1" })]),
    ).toBe("technician_supplied");
    expect(
      summariseCriterionSource([
        measurement({ measurementId: "m-1" }),
        measurement({
          measurementId: "m-2",
          criterion: { source: "none" },
        }),
      ]),
    ).toBe("mixed");
  });
});

// --- architectural boundaries ----------------------------------------

describe("architectural boundaries", () => {
  const dir = resolve(process.cwd(), "lib/safety/rules");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("no rule module imports Prisma, a repository, a route, or the database", () => {
    for (const file of files) {
      const code = readFileSync(resolve(dir, file), "utf8").replace(
        /^[ \t]*(\/\/|\*|\/\*).*$/gm,
        "",
      );
      expect(code, file).not.toMatch(/from\s+["']@\/lib\/db\//);
      expect(code, file).not.toMatch(/from\s+["']@\/lib\/generated\//);
      expect(code, file).not.toMatch(/@prisma\//);
      expect(code, file).not.toMatch(/repositor/i);
      expect(code, file).not.toMatch(/from\s+["']@\/app\//);
    }
  });

  it("no rule module imports an AI module", () => {
    for (const file of files) {
      const code = readFileSync(resolve(dir, file), "utf8").replace(
        /^[ \t]*(\/\/|\*|\/\*).*$/gm,
        "",
      );
      expect(code, file).not.toMatch(/from\s+["']@\/lib\/ai\//);
      expect(code, file).not.toMatch(/anthropic/i);
    }
  });

  it("no rule module mutates diagnostic state", () => {
    for (const file of files) {
      const code = readFileSync(resolve(dir, file), "utf8").replace(
        /^[ \t]*(\/\/|\*|\/\*).*$/gm,
        "",
      );
      expect(code, file).not.toMatch(/diagnosticCause|diagnosticSession/i);
      expect(code, file).not.toMatch(/\.update\(|\.create\(|\.delete\(/);
    }
  });
});
