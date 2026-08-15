import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required").max(200),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
