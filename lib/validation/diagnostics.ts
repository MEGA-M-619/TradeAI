import { z } from "zod";

// See lib/validation/customer.ts for why this is a preprocess step and
// not a `.or(z.literal("")...)` union.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const optionalTrimmed = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

export const DIAGNOSTIC_SESSION_STATUSES = [
  "open",
  "investigating",
  "diagnosed",
  "abandoned",
] as const;

export const DIAGNOSTIC_CAUSE_STATUSES = [
  "candidate",
  "confirmed",
  "ruled_out",
] as const;

export type DiagnosticSessionStatusInput =
  (typeof DIAGNOSTIC_SESSION_STATUSES)[number];
export type DiagnosticCauseStatusInput =
  (typeof DIAGNOSTIC_CAUSE_STATUSES)[number];

export const createDiagnosticSessionSchema = z.object({
  symptom: z.string().trim().min(1, "Symptom is required").max(2000),
});

/**
 * `status` only accepts the literal `"abandoned"`: it's the one
 * technician-initiated direct transition on a session (see
 * diagnosticSessionRepository.abandon). `open` is a creation-only
 * default, `diagnosed` is only ever reached by confirming a cause (see
 * diagnosticCauseRepository.update), and `investigating` has no writer in
 * this phase at all -- none of the three are valid values to PATCH
 * directly, so they're not in this schema's vocabulary.
 */
export const updateDiagnosticSessionSchema = z.object({
  symptom: z.string().trim().min(1, "Symptom is required").max(2000).optional(),
  status: z.literal("abandoned").optional(),
});

export const createCandidateCauseSchema = z.object({
  statement: z.string().trim().min(1, "Statement is required").max(2000),
  recommendedNextTest: optionalTrimmed(2000),
});

/**
 * `recommendedNextTest`/`resolvingMeasurementId` are `.nullable().optional()`
 * on purpose, distinct from create's plain `.optional()`: an update needs
 * to distinguish "leave unchanged" (field absent) from "clear this value"
 * (field explicitly `null`) -- e.g. unlinking a resolving measurement
 * without touching status. `status` is not required on every update:
 * editing `recommendedNextTest` alone should not force a status choice.
 */
export const updateCandidateCauseSchema = z.object({
  status: z.enum(DIAGNOSTIC_CAUSE_STATUSES).optional(),
  recommendedNextTest: z.string().trim().max(2000).nullable().optional(),
  resolvingMeasurementId: z.string().uuid().nullable().optional(),
});

export type CreateDiagnosticSessionInput = z.infer<
  typeof createDiagnosticSessionSchema
>;
export type UpdateDiagnosticSessionInput = z.infer<
  typeof updateDiagnosticSessionSchema
>;
export type CreateCandidateCauseInput = z.infer<
  typeof createCandidateCauseSchema
>;
export type UpdateCandidateCauseInput = z.infer<
  typeof updateCandidateCauseSchema
>;
