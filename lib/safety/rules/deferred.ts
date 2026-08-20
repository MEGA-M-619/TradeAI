/**
 * Rules that are written, reviewed, and deliberately NOT active, because
 * they cannot be stated correctly without a numeric limit from a
 * published electrical standard that this repository has not verified.
 *
 * Nothing here is exported into ACTIVE_RULES, and a unit test enforces
 * that a rule marked `requires_verified_source` never appears there. This
 * file exists so the standards guard is tested against a real instance
 * rather than a hypothetical one, and so the most important known gap in
 * the rule set is recorded in code rather than lost in a document.
 *
 * There are no numbers, citations, or standard names in this file. An
 * invented threshold or a placeholder citation would be exactly the
 * failure the guard is meant to prevent -- worse than the gap itself,
 * because it would look authoritative.
 */

import type { SafetyRule } from "@/lib/safety/rules/types";

export class DeferredRuleInvokedError extends Error {
  constructor(id: string) {
    super(
      `Safety rule "${id}" is deferred pending a verified source and must not be evaluated`,
    );
    this.name = "DeferredRuleInvokedError";
  }
}

/**
 * "A voltage reading indicates the conductor may still be energized."
 *
 * This is the single most valuable rule the engine does not have, and the
 * only foreseeable producer of STOP from measurement data alone. It
 * cannot be written yet: deciding that a reading indicates an energized
 * conductor requires knowing what magnitude counts as energized for the
 * relevant system, and that number must come from a verified standard,
 * not from this codebase's judgement.
 *
 * `evaluate` throws rather than returning null, so activating it without
 * supplying the source fails loudly at the first call instead of silently
 * never firing.
 */
export const energizedConductorIndicationRule: SafetyRule = {
  id: "energized_conductor_indication",
  requires: ["measurements_on_circuit"],
  sourceStatus: "requires_verified_source",
  whenUnknown: {
    message:
      "Whether any measurement indicates an energized conductor could not be established.",
    verify:
      "Independently verify absence of voltage before treating any conductor as de-energized.",
  },
  evaluate: () => {
    throw new DeferredRuleInvokedError("energized_conductor_indication");
  },
};

export const DEFERRED_RULES: readonly SafetyRule[] = [
  energizedConductorIndicationRule,
];
