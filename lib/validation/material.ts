import { z } from "zod";

// Storage-shape fields, matching lib/validation/measurement.ts's
// convention for a job-scoped numeric-input table: the schema mirrors
// what materialRepository persists (unitCostCents, not a dollar figure),
// so the dollar<->cents conversion is a UI-layer concern, not a
// validation-layer one.
export const createMaterialSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(500),
  quantity: z.number().finite().positive(),
  unitCostCents: z.number().finite().int().nonnegative(),
});

export const updateMaterialSchema = createMaterialSchema.partial();

export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;
export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;
