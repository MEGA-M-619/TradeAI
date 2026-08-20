import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_HAZARD_SPECS,
  aiHazardRuleId,
  aiHazardRules,
} from "@/lib/safety/rules/aiHazardCategories";
import { ACTIVE_RULES, applySafetyRule, isSafetyRuleId } from "@/lib/safety/rules";
import { evaluateSafety } from "@/lib/safety/evaluate";
import { known, unknown, type SafetyFacts } from "@/lib/safety/facts";
import { FLOOR_STATE, STATE_PRECEDENCE } from "@/lib/safety/states";
import {
  SAFETY_CATEGORIES,
  type SafetyCategory,
} from "@/lib/validation/assessment";

const STOP_CATEGORIES: SafetyCategory[] = [
  "arc_fault_suspected",
  "water_ingress_energized",
  "thermal_damage_scorching",
];

const VERIFY_CATEGORIES: SafetyCategory[] = [
  "backfed_or_double_lugged_neutral",
  "missing_bonding_or_grounding",
  "aluminium_branch_conductors",
  "recalled_panel_brand",
  "knob_and_tube_or_asbestos_era",
];

/** Facts in which no measurement rule fires, so anything the verdict
 * reports comes from the hazard rules alone. */
function factsWithCategories(categories: SafetyCategory[]): SafetyFacts {
  const measurement = {
    measurementId: "m-1",
    testType: "voltage_ac" as const,
    circuitId: "c-1",
    value: 230,
    unit: "V",
    result: "pass" as const,
    criterion: {
      source: "technician_supplied" as const,
      expectedMin: 216,
      expectedMax: 253,
    },
    recordedAt: "2026-08-19T12:00:00.000Z",
    note: null,
  };
  return {
    circuit_under_investigation: known({ circuitId: "c-1", label: "Kitchen" }),
    measurements_on_job: known([measurement]),
    measurements_on_circuit: known([measurement]),
    ai_hazard_categories: known(categories),
  };
}

const ruleFor = (category: SafetyCategory) =>
  aiHazardRules.find((rule) => rule.id === aiHazardRuleId(category))!;

describe("the mapping is exhaustive and stable", () => {
  it("maps every SafetyCategory exactly once", () => {
    expect(Object.keys(AI_HAZARD_SPECS).sort()).toEqual(
      [...SAFETY_CATEGORIES].sort(),
    );
    expect(aiHazardRules).toHaveLength(SAFETY_CATEGORIES.length);
  });

  it("gives every rule a stable, declared id", () => {
    for (const category of SAFETY_CATEGORIES) {
      const id = aiHazardRuleId(category);
      expect(id).toBe(`ai_hazard_${category}`);
      expect(isSafetyRuleId(id)).toBe(true);
    }
    const ids = aiHazardRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers every rule in ACTIVE_RULES", () => {
    const activeIds = new Set(ACTIVE_RULES.map((r) => r.id));
    for (const rule of aiHazardRules) {
      expect(activeIds.has(rule.id), rule.id).toBe(true);
    }
  });

  it("maps exactly the three acute hazards to STOP", () => {
    const stopCategories = SAFETY_CATEGORIES.filter(
      (c) => AI_HAZARD_SPECS[c].state === "STOP",
    );
    expect([...stopCategories].sort()).toEqual([...STOP_CATEGORIES].sort());
  });

  it("maps the remaining five to INSUFFICIENT_INFORMATION", () => {
    const verifyCategories = SAFETY_CATEGORIES.filter(
      (c) => AI_HAZARD_SPECS[c].state === "INSUFFICIENT_INFORMATION",
    );
    expect([...verifyCategories].sort()).toEqual([...VERIFY_CATEGORIES].sort());
  });

  it("every rule requires only the hazard fact", () => {
    for (const rule of aiHazardRules) {
      expect(rule.requires).toEqual(["ai_hazard_categories"]);
    }
  });

  it("every rule carries non-empty constant text", () => {
    for (const category of SAFETY_CATEGORIES) {
      const spec = AI_HAZARD_SPECS[category];
      expect(spec.message.trim().length).toBeGreaterThan(0);
      expect(spec.verify.trim().length).toBeGreaterThan(0);
      const rule = ruleFor(category);
      expect(rule.whenUnknown.message.trim().length).toBeGreaterThan(0);
      expect(rule.whenUnknown.verify.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("each category produces its mapped state", () => {
  it("each acute hazard alone produces STOP", () => {
    for (const category of STOP_CATEGORIES) {
      const result = evaluateSafety(factsWithCategories([category]));
      expect(result.state, category).toBe("STOP");
      expect(result.firedRuleIds).toContain(aiHazardRuleId(category));
    }
  });

  it("each verification-required hazard alone produces INSUFFICIENT_INFORMATION", () => {
    for (const category of VERIFY_CATEGORIES) {
      const result = evaluateSafety(factsWithCategories([category]));
      expect(result.state, category).toBe("INSUFFICIENT_INFORMATION");
      expect(result.firedRuleIds).toContain(aiHazardRuleId(category));
    }
  });

  it("a rule stays silent for a category that was not flagged", () => {
    const facts = factsWithCategories(["arc_fault_suspected"]);
    for (const category of SAFETY_CATEGORIES) {
      const finding = applySafetyRule(ruleFor(category), facts);
      if (category === "arc_fault_suspected") {
        expect(finding).not.toBeNull();
      } else {
        expect(finding, category).toBeNull();
      }
    }
  });

  it("cites no measurement, because the signal is not a reading", () => {
    const finding = applySafetyRule(
      ruleFor("arc_fault_suspected"),
      factsWithCategories(["arc_fault_suspected"]),
    );
    expect(finding?.basis.measurementIds).toEqual([]);
    expect(finding?.basis.criterionSource).toBeNull();
  });
});

describe("aggregation across categories", () => {
  it("an empty Known([]) produces no hazard escalation at all", () => {
    const result = evaluateSafety(factsWithCategories([]));
    expect(result.state).toBe(FLOOR_STATE);
    expect(result.firedRuleIds).toEqual([]);
  });

  it("mixed categories take the strongest state", () => {
    const result = evaluateSafety(
      factsWithCategories([
        "recalled_panel_brand",
        "arc_fault_suspected",
        "missing_bonding_or_grounding",
      ]),
    );
    expect(result.state).toBe("STOP");
    expect(result.firedRuleIds).toHaveLength(3);
  });

  it("order of the flagged categories cannot change the verdict", () => {
    const a = evaluateSafety(
      factsWithCategories(["arc_fault_suspected", "recalled_panel_brand"]),
    );
    const b = evaluateSafety(
      factsWithCategories(["recalled_panel_brand", "arc_fault_suspected"]),
    );
    expect(a.state).toBe(b.state);
    expect(a.state).toBe("STOP");
  });

  it("every flagged category yields its own finding", () => {
    const result = evaluateSafety(factsWithCategories([...SAFETY_CATEGORIES]));
    expect(result.firedRuleIds).toHaveLength(SAFETY_CATEGORIES.length);
    expect(result.state).toBe("STOP");
  });
});

describe("escalation-only", () => {
  it("a hazard rule can never emit the floor state", () => {
    for (const category of SAFETY_CATEGORIES) {
      const finding = applySafetyRule(
        ruleFor(category),
        factsWithCategories([category]),
      );
      expect(finding?.state, category).not.toBe(FLOOR_STATE);
    }
  });

  it("an existing STOP is never lowered by a weaker hazard", () => {
    // A STOP category plus every verification-required one: the verdict
    // must remain STOP.
    const result = evaluateSafety(
      factsWithCategories(["arc_fault_suspected", ...VERIFY_CATEGORIES]),
    );
    expect(result.state).toBe("STOP");
  });

  it("adding a hazard never lowers the verdict", () => {
    let flagged: SafetyCategory[] = [];
    let previous = STATE_PRECEDENCE[evaluateSafety(factsWithCategories([])).state];
    // Deliberately weakest-first, so a naive last-wins implementation
    // would be caught by the reverse pass below rather than here.
    for (const category of [...VERIFY_CATEGORIES, ...STOP_CATEGORIES]) {
      flagged = [...flagged, category];
      const next = STATE_PRECEDENCE[evaluateSafety(factsWithCategories(flagged)).state];
      expect(next, category).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("adding a weak hazard after a STOP still cannot lower it", () => {
    let flagged: SafetyCategory[] = ["arc_fault_suspected"];
    expect(evaluateSafety(factsWithCategories(flagged)).state).toBe("STOP");
    for (const category of VERIFY_CATEGORIES) {
      flagged = [...flagged, category];
      expect(evaluateSafety(factsWithCategories(flagged)).state, category).toBe(
        "STOP",
      );
    }
  });
});

describe("unknown handling follows the existing fail-closed semantics", () => {
  const unknownFacts: SafetyFacts = {
    ...factsWithCategories([]),
    ai_hazard_categories: unknown("not_recorded", "session unreadable"),
  };

  it("an Unknown hazard fact escalates rather than abstaining", () => {
    const result = evaluateSafety(unknownFacts);
    expect(result.state).toBe("INSUFFICIENT_INFORMATION");
  });

  it("every hazard rule escalates on the Unknown path", () => {
    for (const category of SAFETY_CATEGORIES) {
      const finding = applySafetyRule(ruleFor(category), unknownFacts);
      expect(finding?.state, category).toBe("INSUFFICIENT_INFORMATION");
      expect(finding?.basis.unknownReason).toBe("not_recorded");
    }
  });

  it("the eight unknown-path verifications collapse to one line", () => {
    // Identical whenUnknown text across the rules, so the technician sees
    // one instruction rather than eight copies.
    const result = evaluateSafety(unknownFacts);
    const hazardVerifications = new Set(
      aiHazardRules.map((r) => r.whenUnknown.verify),
    );
    expect(hazardVerifications.size).toBe(1);
    expect(result.verifications).toContain([...hazardVerifications][0]);
  });

  it("never calls a rule's predicate when the fact is Unknown", () => {
    // unwrapKnown would throw if it were called, so a passing assertion
    // here also proves the guard runs first.
    expect(() =>
      applySafetyRule(ruleFor("arc_fault_suspected"), unknownFacts),
    ).not.toThrow();
  });
});

describe("no unverified claim is introduced", () => {
  const source = readFileSync(
    resolve(process.cwd(), "lib/safety/rules/aiHazardCategories.ts"),
    "utf8",
  );
  const code = source.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, "");

  it("every hazard rule declares no_threshold_required", () => {
    for (const rule of aiHazardRules) {
      expect(rule.sourceStatus, rule.id).toBe("no_threshold_required");
      expect(rule.source, rule.id).toBeUndefined();
    }
  });

  it("names no standard and states no numeric limit", () => {
    expect(code).not.toMatch(/\bNEC\b|\bIEC\b|BS\s?7671|NFPA|\bIET\b/);
    expect(code).not.toMatch(/\.value\s*[<>]=?/);
    expect(code).not.toMatch(/expected(Min|Max)/);
  });

  it("claims nothing is safe or compliant", () => {
    for (const category of SAFETY_CATEGORIES) {
      for (const text of [
        AI_HAZARD_SPECS[category].message,
        AI_HAZARD_SPECS[category].verify,
      ]) {
        expect(text, category).not.toMatch(/\b(?:is|are)\s+safe\b/i);
        expect(text, category).not.toMatch(/\bcompliant\b/i);
        expect(text, category).not.toMatch(/\ball clear\b/i);
      }
    }
  });

  it("imports no AI module and reads no measurement", () => {
    // The hazard signal arrives as a persisted fact, never by reaching
    // into the assessment pipeline.
    expect(code).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(code).not.toMatch(/from\s+["']@\/lib\/db\//);
    expect(code).not.toMatch(/anthropic/i);
  });
});
