import { unwrapKnown } from "@/lib/safety/facts";
import type {
  AiHazardRuleId,
  EscalatedState,
  SafetyRule,
} from "@/lib/safety/rules/types";
import type { SafetyCategory } from "@/lib/validation/assessment";

/**
 * One rule per hazard category the AI assessment can flag.
 *
 * The chain these rules sit in matters more than the rules themselves:
 *
 *   model selects a category from a closed vocabulary
 *     -> schema-validated and persisted as an AiAssessmentFinding
 *       -> re-filtered against that vocabulary by the fact builder
 *         -> ai_hazard_categories, a deterministic SafetyFact
 *           -> these rules, which map category to state
 *             -> evaluateSafety, which takes the max
 *
 * At no point does model output set a state. It contributes a *category*;
 * the mapping from category to state is fixed here, in code, and is the
 * same every time. The model cannot reach the state, cannot reach the
 * mapping, and cannot reach the fact.
 *
 * Escalation-only is structural, not a promise made here. `RuleOutcome`
 * types its state as `EscalatedState`, which excludes the floor, so these
 * rules have no way to express "this is fine"; `applySafetyRule` rejects
 * a floor outcome at runtime as a backstop; and `evaluateSafety` combines
 * findings with a max fold. A hazard flag can therefore raise a verdict
 * or leave it alone, and there is no expressible way for it to lower one.
 *
 * No thresholds, standards, or code citations appear here, and none are
 * needed: these are observational categories ("scorching was noted"), not
 * magnitude comparisons. That is exactly why they can ship while a
 * voltage or insulation-resistance limit cannot.
 */

type AiHazardSpec = {
  readonly state: EscalatedState;
  readonly message: string;
  readonly verify: string;
};

/**
 * Exhaustively keyed on SafetyCategory: adding a category to
 * SAFETY_CATEGORIES without a mapping here is a compile error, not a
 * hazard that silently stops being evaluated. Same guarantee
 * CATEGORY_RULES relies on in the AI-assessment layer.
 *
 * The three `STOP` entries are the acute hazards; the five
 * `INSUFFICIENT_INFORMATION` entries are conditions the system cannot
 * judge on its own and that name a specific verification. There is no
 * intermediate tier in the lattice, and adding one would mean revisiting
 * every existing rule's ordinal position.
 */
const AI_HAZARD_SPECS: Record<SafetyCategory, AiHazardSpec> = {
  arc_fault_suspected: {
    state: "STOP",
    message:
      "The latest completed assessment flagged possible arc-fault indicators on this job.",
    verify:
      "Stop work on the affected circuit and have a licensed electrician inspect it de-energized before going further.",
  },
  water_ingress_energized: {
    state: "STOP",
    message:
      "The latest completed assessment flagged possible water ingress near energized equipment.",
    verify:
      "Stop work and confirm the equipment is isolated before approaching it.",
  },
  thermal_damage_scorching: {
    state: "STOP",
    message:
      "The latest completed assessment flagged signs of heat damage or scorching.",
    verify:
      "Stop work on the affected component until a licensed electrician has inspected it.",
  },
  backfed_or_double_lugged_neutral: {
    state: "INSUFFICIENT_INFORMATION",
    message:
      "The latest completed assessment flagged possible backfed or double-lugged neutral connections.",
    verify:
      "Have a licensed electrician verify the neutral terminations before relying on this circuit.",
  },
  missing_bonding_or_grounding: {
    state: "INSUFFICIENT_INFORMATION",
    message:
      "The latest completed assessment flagged possible missing or inadequate bonding or grounding.",
    verify:
      "Have a licensed electrician verify the bonding and grounding arrangement.",
  },
  aluminium_branch_conductors: {
    state: "INSUFFICIENT_INFORMATION",
    message:
      "The latest completed assessment flagged possible aluminium branch-circuit conductors.",
    verify:
      "Have a licensed electrician verify that every termination is rated for aluminium.",
  },
  recalled_panel_brand: {
    state: "INSUFFICIENT_INFORMATION",
    message:
      "The latest completed assessment flagged that the panel or equipment may match a brand subject to a safety recall.",
    verify:
      "Independently check the panel against current recall notices before relying on it.",
  },
  knob_and_tube_or_asbestos_era: {
    state: "INSUFFICIENT_INFORMATION",
    message:
      "The latest completed assessment flagged possible knob-and-tube wiring or components from an era when asbestos-containing materials were common.",
    verify:
      "Have a licensed electrician confirm the wiring type and the handling requirements before disturbing it.",
  },
};

/**
 * Identical across all eight rules on purpose. When the fact is Unknown
 * the reason is the same for every category -- the session could not be
 * read at all -- so a single de-duplicated line in the verification list
 * is more useful than eight copies of the same instruction.
 */
const WHEN_UNKNOWN = {
  message:
    "Whether the assessment flagged any hazard for this job could not be established.",
  verify:
    "Reload this investigation. If the problem persists, treat the assessment's findings as unread.",
} as const;

export function aiHazardRuleId(category: SafetyCategory): AiHazardRuleId {
  return `ai_hazard_${category}`;
}

function buildRule(category: SafetyCategory): SafetyRule {
  const spec = AI_HAZARD_SPECS[category];
  return {
    id: aiHazardRuleId(category),
    requires: ["ai_hazard_categories"],
    // Observational, not numeric. Nothing here depends on a published
    // limit, so nothing here may claim one.
    sourceStatus: "no_threshold_required",
    whenUnknown: { ...WHEN_UNKNOWN },
    evaluate: (facts) => {
      const flagged = unwrapKnown(facts.ai_hazard_categories);
      if (!flagged.includes(category)) return null;
      return {
        state: spec.state,
        message: spec.message,
        verify: spec.verify,
        // These rules cite no measurement: the signal is a category on an
        // assessment finding, not a reading.
        measurementIds: [],
        criterionSource: null,
      };
    },
  };
}

/** Registry order follows the declaration order of AI_HAZARD_SPECS, so
 * evaluation is reproducible. Order carries no priority meaning --
 * findings combine by taking the most restrictive state. */
export const aiHazardRules: readonly SafetyRule[] = (
  Object.keys(AI_HAZARD_SPECS) as SafetyCategory[]
).map(buildRule);

export { AI_HAZARD_SPECS };
