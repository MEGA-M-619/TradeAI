import { z } from "zod";

// See lib/validation/customer.ts for why this is a preprocess step and
// not a `.or(z.literal("")...)` union.
const emptyToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

const optionalProblemDescription = () =>
  z.preprocess(emptyToUndefined, z.string().trim().max(5000).optional());

export const createJobSchema = z.object({
  customerId: z.string().uuid(),
  title: z.string().trim().min(1, "Job title is required").max(200),
  problemDescription: optionalProblemDescription(),
});

export const updateJobSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  problemDescription: optionalProblemDescription(),
  status: z.enum(["open", "in_progress", "completed"]).optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
