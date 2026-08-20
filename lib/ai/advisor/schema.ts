import { z } from "zod";

/**
 * The AI advisor's data contract, on both sides.
 *
 * `AdvisorContext` is what the server builds from persisted rows and the
 * deterministic engines, and is the only thing the model is told.
 * `advisorResponseSchema` is what the model must return, projected into
 * the tool's input_schema at call time and validated again on the way
 * back -- one schema on both sides, so the contract and the validator
 * cannot drift. Same discipline as lib/validation/assessment.ts.
 *
 * What is deliberately absent from the response is as load-bearing as
 * what is present. There is no safety-state field, no
 * `isSafe`/`safeToProceed` boolean, and no numeric confidence. The model
 * has nowhere to declare a safety verdict, because the Safety Engine owns
 * that entirely; and nowhere to invent a precision it does not have.
 */

// --- Context (server -> model) ----------------------------------------

/** A measurement, exactly as recorded and evaluated. The advisor sees the
 * value, its unit, the range it was judged against, and where that range
 * came from -- so it can never present a technician's own expectation as
 * a standard. */
export type AdvisorMeasurement = {
  id: string;
  testType: string;
  value: number;
  unit: string;
  expectedMin: number | null;
  expectedMax: number | null;
  criterionSource: "technician_supplied" | "none";
  /** Deterministic, from lib/diagnostics/measurementRules.ts. */
  evaluation: "pass" | "fail" | "inconclusive" | "not_applicable" | null;
  circuitLabel: string | null;
  recordedAt: string;
  note: string | null;
};

export type AdvisorCause = {
  id: string;
  statement: string;
  status: "candidate" | "confirmed" | "ruled_out";
  recommendedNextTest: string | null;
  resolvingMeasurementId: string | null;
};

export type AdvisorSafety = {
  state: "STOP" | "INSUFFICIENT_INFORMATION" | "PROCEED_WITH_PRECAUTIONS";
  rulesetVersion: string;
  firedRuleIds: string[];
  findings: { ruleId: string; message: string }[];
  verifications: string[];
  unknownFacts: string[];
  precautions: string[];
};

export type AdvisorContext = {
  job: { title: string; problemDescription: string | null };
  circuit: { label: string; panelLabel: string | null } | null;
  /** Why the circuit is unknown, when it is. Carried through so the model
   * can explain the gap rather than guess past it. */
  circuitUnknownReason: string | null;
  session: { symptom: string; status: string };
  measurements: AdvisorMeasurement[];
  causes: AdvisorCause[];
  evidenceCount: number;
  safety: AdvisorSafety;
};

// --- Response (model -> server) ---------------------------------------

/**
 * Qualitative only. A numeric confidence here would be invented
 * precision: nothing in the system produces a calibrated probability, and
 * a number would read as though something did.
 */
export const SUPPORT_LEVELS = [
  "well_supported",
  "plausible",
  "insufficient_evidence",
] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

const measurementIdSchema = z.string().uuid();

const evidenceItemSchema = z.object({
  statement: z.string().trim().min(1).max(500),
  /** Must resolve against the context. Validated in
   * lib/ai/advisor/validate.ts -- a fabricated id fails the whole
   * response rather than being silently dropped. */
  citedMeasurementIds: z.array(measurementIdSchema).max(20),
});

const explanationSchema = z.object({
  statement: z.string().trim().min(1).max(500),
  /** The id of an existing candidate cause this explanation corresponds
   * to, or null when the model is proposing something not yet recorded.
   * The model never creates or confirms a cause -- that stays a
   * technician action through the existing workflow. */
  causeId: z.string().uuid().nullable(),
  support: z.enum(SUPPORT_LEVELS),
  reasoning: z.string().trim().min(1).max(800),
  citedMeasurementIds: z.array(measurementIdSchema).max(20),
});

export const advisorResponseSchema = z.object({
  /** What the current evidence indicates. */
  assessment: z.string().trim().min(1).max(1200),
  evidence: z.array(evidenceItemSchema).max(10),
  likelyExplanations: z.array(explanationSchema).max(6),
  contradictions: z.array(z.string().trim().min(1).max(400)).max(6),
  /** What TradeAI does not know, and why it matters. */
  unknowns: z.array(z.string().trim().min(1).max(400)).max(10),
  nextCheck: z
    .object({
      action: z.string().trim().min(1).max(400),
      whyItMatters: z.string().trim().min(1).max(400),
    })
    .nullable(),
  /** Plain-language explanation of the deterministic safety situation.
   * Explanation only -- the state itself comes from the Safety Engine and
   * is rendered separately. */
  safetyNotes: z.array(z.string().trim().min(1).max(400)).max(6),
  /** Whether a licensed second opinion / escalation is warranted. */
  recommendEscalation: z.boolean(),
  escalationReason: z.string().trim().max(400).nullable(),
});

export type AdvisorResponse = z.infer<typeof advisorResponseSchema>;

export const ADVISOR_TOOL_NAME = "record_diagnostic_advice";
export const ADVISOR_PROMPT_VERSION = "2026-08-19.1";
export const ADVISOR_SCHEMA_VERSION = "2026-08-19.1";

/** Projected into the provider's tool input_schema, so the model is
 * constrained by the API rather than by prompt wording alone. Cross-field
 * rules that JSON Schema cannot express are re-checked by the Zod parse
 * and the grounding validator on the way back. */
export function buildAdvisorToolSchema(): Record<string, unknown> {
  return z.toJSONSchema(advisorResponseSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
}
