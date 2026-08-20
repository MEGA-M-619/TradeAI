import { z } from "zod";

// See lib/validation/customer.ts for why this is a preprocess step and
// not a `.or(z.literal("")...)` union.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const optionalTrimmed = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

export const createCircuitSchema = z.object({
  label: z.string().trim().min(1, "Circuit label is required").max(200),
  panelLabel: optionalTrimmed(200),
  breakerRating: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().max(600).optional(),
  ),
  description: optionalTrimmed(2000),
});

export const updateCircuitSchema = createCircuitSchema.partial();

export type CreateCircuitInput = z.infer<typeof createCircuitSchema>;
export type UpdateCircuitInput = z.infer<typeof updateCircuitSchema>;
