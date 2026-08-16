import { z } from "zod";
import { MAX_EVIDENCE_PER_JOB } from "@/lib/validation/evidence";

/**
 * This file is the single source of truth for the AI-assessment output
 * shape. `modelOutputSchema` below is projected into the tool's
 * `input_schema` at call time (see lib/ai/tool.ts) and is also what the
 * response is validated against at persistence time -- the same schema on
 * both sides, so the model's contract and the validator cannot drift.
 *
 * What is deliberately absent is as load-bearing as what's present: no
 * price/quantity/material-cost field exists anywhere (financial
 * calculation stays deterministic, per the original architecture), no
 * `isSafe`/`isCodeCompliant` boolean exists (the model has nowhere to
 * declare something safe or compliant), and confidence has no numeric
 * field (ordinal only, per the approved Phase 3 decision).
 */

export const MAX_ASSESSMENT_IMAGES = 8;

/** Closed vocabulary. The model selects from this list; it does not write
 * free text here. lib/ai/safetyRules.ts reads these categories to emit
 * warnings whose message text is a constant, never model output. */
export const SAFETY_CATEGORIES = [
  "arc_fault_suspected",
  "water_ingress_energized",
  "thermal_damage_scorching",
  "backfed_or_double_lugged_neutral",
  "missing_bonding_or_grounding",
  "aluminium_branch_conductors",
  "recalled_panel_brand",
  "knob_and_tube_or_asbestos_era",
] as const;

export const safetyCategorySchema = z.enum(SAFETY_CATEGORIES);
export type SafetyCategory = z.infer<typeof safetyCategorySchema>;

/** Ordinal reference to a sent image, e.g. "E1".."E8" -- never a database
 * id (see lib/ai/citations.ts, which is where E-refs are actually resolved
 * against the run's input snapshot; this regex only catches obviously
 * malformed refs early). */
const evidenceRefSchema = z
  .string()
  .regex(/^E[1-8]$/, "must be an evidence reference like E1..E8");

const findingRefSchema = z
  .string()
  .regex(/^[OH][1-9][0-9]*$/, "must be a finding reference like O1 or H1");

export const confidenceLevelSchema = z.enum(["low", "medium", "high"]);

const observationSchema = z.object({
  ref: findingRefSchema,
  statement: z.string().trim().min(1).max(1000),
  citedEvidence: z.array(evidenceRefSchema).min(1),
  confidence: confidenceLevelSchema,
  rationale: z.string().trim().min(1).max(1000),
});

const discriminatingTestSchema = z.object({
  test: z.string().trim().min(1).max(500),
  rulesInIfPositive: z.string().trim().min(1).max(500),
  rulesOutIfNegative: z.string().trim().min(1).max(500),
});

const hypothesisSchema = z.object({
  ref: findingRefSchema,
  statement: z.string().trim().min(1).max(1000),
  citedEvidence: z.array(evidenceRefSchema).min(1),
  confidence: confidenceLevelSchema,
  rationale: z.string().trim().min(1).max(1000),
  // Required and non-empty on purpose: a hypothesis with no falsifying
  // test, and no statement of what would change the model's mind, is a
  // guess wearing a lab coat. The schema declines to carry one.
  whatWouldChangeMyMind: z.string().trim().min(1).max(500),
  discriminatingTests: z.array(discriminatingTestSchema).min(1).max(5),
  safetyCategories: z.array(safetyCategorySchema).max(SAFETY_CATEGORIES.length),
});

const followUpQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500),
  whyItMatters: z.string().trim().min(1).max(500),
  answersWouldRuleIn: z.array(z.string().trim().min(1).max(300)).max(10),
});

/**
 * `insufficient_evidence` is a first-class success outcome, not a failure
 * path -- if abstention is awkward to express, a model will confabulate
 * rather than abstain. When overallStatus is insufficient_evidence, every
 * other array must be empty; the refine below makes that the only legal
 * shape rather than trusting the model not to mix outcomes.
 */
export const modelOutputSchema = z
  .object({
    overallStatus: z.enum(["assessment_provided", "insufficient_evidence"]),
    insufficientReason: z.string().trim().min(1).max(1000).optional(),
    observations: z.array(observationSchema).max(20),
    hypotheses: z.array(hypothesisSchema).max(10),
    followUpQuestions: z.array(followUpQuestionSchema).max(10),
    limitations: z.array(z.string().trim().min(1).max(500)).max(10),
  })
  .superRefine((val, ctx) => {
    if (val.overallStatus === "insufficient_evidence") {
      if (!val.insufficientReason) {
        ctx.addIssue({
          code: "custom",
          path: ["insufficientReason"],
          message: "required when overallStatus is insufficient_evidence",
        });
      }
      if (val.observations.length || val.hypotheses.length) {
        ctx.addIssue({
          code: "custom",
          path: ["observations"],
          message:
            "must be empty when overallStatus is insufficient_evidence",
        });
      }
    }
    if (val.overallStatus === "assessment_provided") {
      if (val.observations.length === 0 && val.hypotheses.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["observations"],
          message:
            "assessment_provided requires at least one observation or hypothesis",
        });
      }
    }
    // Every ref (O1, H1, ...) must be unique within the response -- the DB
    // has a backstop unique constraint, but catching a collision here
    // gives a clearer failure category than a raw constraint violation.
    const refs = [
      ...val.observations.map((o) => o.ref),
      ...val.hypotheses.map((h) => h.ref),
    ];
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({
        code: "custom",
        path: ["observations"],
        message: "finding refs must be unique within the assessment",
      });
    }
  });

export type ModelOutput = z.infer<typeof modelOutputSchema>;

// --- API request/response schemas -------------------------------------

export const createAssessmentSchema = z.object({
  evidenceIds: z
    .array(z.string().uuid())
    .min(1, "select at least one photo")
    .max(MAX_ASSESSMENT_IMAGES, `select at most ${MAX_ASSESSMENT_IMAGES} photos`)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate evidence ids"),
  /** Escalation is an explicit technician action (Opus 5, D2), never an
   * automatic upgrade path chosen by the standard run. */
  escalate: z.boolean().optional().default(false),
});
export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;

export const verdictSchema = z.object({
  verdict: z.enum(["confirmed", "rejected", "amended", "unresolved"]),
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
});
export type VerdictInput = z.infer<typeof verdictSchema>;

// Sanity check, not a hard business rule: the image cap here must never
// exceed the evidence-per-job cap, or "select up to 8" could be a
// contradiction for a job with fewer than 8 photos in total. Asserted at
// module load so a future edit to either constant fails loudly.
if (MAX_ASSESSMENT_IMAGES > MAX_EVIDENCE_PER_JOB) {
  throw new Error(
    "MAX_ASSESSMENT_IMAGES must not exceed MAX_EVIDENCE_PER_JOB",
  );
}
