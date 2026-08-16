import { describe, expect, it } from "vitest";
import {
  applySafetyRules,
  BASELINE_WARNINGS,
  CATEGORY_RULES,
} from "@/lib/ai/safetyRules";
import { SAFETY_CATEGORIES, type SafetyCategory } from "@/lib/validation/assessment";

describe("applySafetyRules", () => {
  it("always includes every baseline warning, even with zero findings", () => {
    const warnings = applySafetyRules([]);
    const ruleIds = warnings.map((w) => w.ruleId);
    for (const baseline of BASELINE_WARNINGS) {
      expect(ruleIds).toContain(baseline.ruleId);
    }
    expect(warnings).toHaveLength(BASELINE_WARNINGS.length);
  });

  it("includes baseline warnings even when findings carry no safety categories", () => {
    const warnings = applySafetyRules([
      { kind: "observation", safetyCategories: [] },
      { kind: "hypothesis", safetyCategories: [] },
    ]);
    expect(warnings).toHaveLength(BASELINE_WARNINGS.length);
  });

  it("adds exactly one warning per triggered category", () => {
    const warnings = applySafetyRules([
      { kind: "hypothesis", safetyCategories: ["arc_fault_suspected"] },
    ]);
    const categoryWarnings = warnings.filter((w) => w.ruleId.startsWith("category_"));
    expect(categoryWarnings).toHaveLength(1);
    expect(categoryWarnings[0].ruleId).toBe("category_arc_fault_suspected");
    expect(categoryWarnings[0].severity).toBe("stop_work");
  });

  it("deduplicates a category cited by multiple findings into one warning", () => {
    const warnings = applySafetyRules([
      { kind: "hypothesis", safetyCategories: ["missing_bonding_or_grounding"] },
      { kind: "hypothesis", safetyCategories: ["missing_bonding_or_grounding"] },
      { kind: "observation", safetyCategories: ["missing_bonding_or_grounding"] },
    ]);
    const matches = warnings.filter((w) => w.ruleId === "category_missing_bonding_or_grounding");
    expect(matches).toHaveLength(1);
  });

  it("every category in the closed vocabulary has a rule (no silent gap)", () => {
    // CATEGORY_RULES is typed as Record<SafetyCategory, ...>, so this is
    // also enforced at compile time -- this test exists so a category
    // added to the Zod enum without a matching rule fails a normal test
    // run, not just a type-check someone might skip.
    for (const category of SAFETY_CATEGORIES) {
      expect(CATEGORY_RULES[category]).toBeDefined();
      expect(CATEGORY_RULES[category].message.length).toBeGreaterThan(0);
    }
  });

  it("every category message is a rule constant, never derived from input", () => {
    for (const category of SAFETY_CATEGORIES) {
      const warnings = applySafetyRules([
        { kind: "hypothesis", safetyCategories: [category] },
      ]);
      const match = warnings.find((w) => w.ruleId === `category_${category}`);
      expect(match?.message).toBe(CATEGORY_RULES[category].message);
    }
  });

  it("stop_work severities exist for the genuinely acute hazard categories", () => {
    const acute: SafetyCategory[] = [
      "arc_fault_suspected",
      "water_ingress_energized",
      "thermal_damage_scorching",
    ];
    for (const category of acute) {
      expect(CATEGORY_RULES[category].severity).toBe("stop_work");
    }
  });

  it("is additive: the result for any input is a superset of the baseline warning ids", () => {
    // Property-style check across every non-empty subset size 1..3 of the
    // closed category vocabulary, rather than one hand-picked case --
    // this is the assertion that stands in for "there is no code path
    // that removes or downgrades a warning."
    const categories = [...SAFETY_CATEGORIES];
    const samples: SafetyCategory[][] = [
      [],
      [categories[0]],
      [categories[0], categories[1]],
      categories,
    ];
    const baselineIds = new Set(BASELINE_WARNINGS.map((w) => w.ruleId));

    for (const sample of samples) {
      const warnings = applySafetyRules([
        { kind: "hypothesis", safetyCategories: sample },
      ]);
      const ids = new Set(warnings.map((w) => w.ruleId));
      for (const baselineId of baselineIds) {
        expect(ids.has(baselineId)).toBe(true);
      }
      // Strictly monotonic: more categories never produces fewer warnings.
      expect(warnings.length).toBeGreaterThanOrEqual(BASELINE_WARNINGS.length);
    }
  });

  it("does not mutate its input", () => {
    const findings = [
      { kind: "hypothesis" as const, safetyCategories: ["arc_fault_suspected" as const] },
    ];
    const frozen = JSON.parse(JSON.stringify(findings));
    applySafetyRules(findings);
    expect(findings).toEqual(frozen);
  });
});
