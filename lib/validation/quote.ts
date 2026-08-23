import { z } from "zod";

// Storage-shape fields, matching lib/validation/material.ts's convention:
// unitPriceCents, not a dollar figure -- the dollar<->cents conversion is
// a UI-layer concern, not a validation-layer one.
export const createLaborLineItemSchema = z.object({
  description: z.string().trim().min(1, "Description is required").max(500),
  quantity: z.number().finite().positive(),
  unitPriceCents: z.number().finite().int().nonnegative(),
});

export const updateQuoteLineItemSchema = createLaborLineItemSchema.partial();

export type CreateLaborLineItemInput = z.infer<typeof createLaborLineItemSchema>;
export type UpdateQuoteLineItemInput = z.infer<typeof updateQuoteLineItemSchema>;
