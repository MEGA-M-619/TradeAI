import type { SafetyCategory } from "@/lib/validation/assessment";

/**
 * The deterministic safety layer. Prompt-only safety is not safety: this
 * module is a pure function with no model involvement, so a mandatory
 * warning's presence never depends on a good generation. It has no
 * parameter, branch, or return path that removes or downgrades a warning
 * -- every code path here only ever appends to the result. `message` is
 * always a string literal from RULES/BASELINE_WARNINGS below, never
 * model-generated text.
 */

export type SafetySeverity = "advisory" | "mandatory" | "stop_work";

export type SafetyWarning = {
  ruleId: string;
  severity: SafetySeverity;
  message: string;
};

/** Attach to every assessment unconditionally, regardless of what the
 * model found -- these hold even for an assessment with zero findings. */
const BASELINE_WARNINGS: readonly SafetyWarning[] = [
  {
    ruleId: "baseline_deenergize",
    severity: "advisory",
    message:
      "Always de-energize and independently verify absence of voltage before contact with any conductor, terminal, or component discussed in this assessment.",
  },
  {
    ruleId: "baseline_not_a_diagnosis",
    severity: "advisory",
    message:
      "This is an AI-generated assessment, not a diagnosis. Every finding must be verified against the physical installation by a licensed electrician before any decision is made.",
  },
  {
    ruleId: "baseline_code_defers",
    severity: "advisory",
    message:
      "Code compliance and inspection requirements are governed by the applicable local authority, not by this assessment.",
  },
];

/** One entry per SafetyCategory (see lib/validation/assessment.ts) --
 * exhaustively typed as Record<SafetyCategory, ...> so adding a category
 * to the Zod enum without adding a rule here is a type error, not a
 * silent gap. */
const CATEGORY_RULES: Record<
  SafetyCategory,
  { severity: SafetySeverity; message: string }
> = {
  arc_fault_suspected: {
    severity: "stop_work",
    message:
      "Possible arc fault indicators were noted. Stop work on the affected circuit until it has been de-energized and inspected by a licensed electrician -- arcing is a fire and shock hazard that can escalate quickly.",
  },
  water_ingress_energized: {
    severity: "stop_work",
    message:
      "Possible water ingress near energized equipment was noted. Do not approach or operate the equipment until it has been confirmed de-energized -- water and electricity together are an immediate shock hazard.",
  },
  thermal_damage_scorching: {
    severity: "stop_work",
    message:
      "Signs of heat damage or scorching were noted. Stop work on the affected component until a licensed electrician has confirmed it is safe to proceed -- existing thermal damage indicates a fault that may still be active.",
  },
  backfed_or_double_lugged_neutral: {
    severity: "mandatory",
    message:
      "Possible backfed or double-lugged neutral connections were noted. This is a recognized hazard pattern that should be verified and corrected by a licensed electrician.",
  },
  missing_bonding_or_grounding: {
    severity: "mandatory",
    message:
      "Possible missing or inadequate bonding/grounding was noted. This should be verified against code requirements by a licensed electrician.",
  },
  aluminium_branch_conductors: {
    severity: "mandatory",
    message:
      "Possible aluminium branch-circuit conductors were noted. These require connectors and terminations rated for aluminium, and existing connections should be verified by a licensed electrician.",
  },
  recalled_panel_brand: {
    severity: "mandatory",
    message:
      "The panel or equipment shown may match a brand or model subject to a safety recall. This should be independently verified against current recall notices by a licensed electrician.",
  },
  knob_and_tube_or_asbestos_era: {
    severity: "mandatory",
    message:
      "The installation may include knob-and-tube wiring or components from an era where asbestos-containing materials were common. Handling and any disturbance should follow the applicable safety and abatement requirements.",
  },
};

export type SafetyRuleFindingInput = {
  kind: "observation" | "hypothesis";
  safetyCategories: readonly SafetyCategory[];
};

/**
 * Additive-only by construction: `warnings` starts as a copy of the
 * baseline set and every subsequent step only ever pushes a new entry.
 * There is no filter, no early return, and no code path that removes an
 * already-added warning -- see the property test in
 * tests/lib/safetyRules.test.ts that asserts the result is never a subset
 * of the baseline for any input.
 */
export function applySafetyRules(
  findings: readonly SafetyRuleFindingInput[],
): SafetyWarning[] {
  const warnings: SafetyWarning[] = BASELINE_WARNINGS.map((w) => ({ ...w }));
  const seen = new Set<SafetyCategory>();

  for (const finding of findings) {
    for (const category of finding.safetyCategories) {
      if (seen.has(category)) continue;
      seen.add(category);
      const rule = CATEGORY_RULES[category];
      warnings.push({
        ruleId: `category_${category}`,
        severity: rule.severity,
        message: rule.message,
      });
    }
  }

  return warnings;
}

export { BASELINE_WARNINGS, CATEGORY_RULES };
