import { z } from "zod";

/**
 * The advice request body.
 *
 * Note what is deliberately absent, which is the whole point: no
 * measurements, no evaluations, no safety state, no cause statuses, no
 * model id, no organization or job id. All of that is derived server-side
 * from the verified session (see lib/ai/advisor/context.ts). Accepting
 * any of it here would let a caller manufacture the facts the model
 * reasons over -- and choose a more expensive model while they were at
 * it.
 *
 * A question is all a client may contribute, and it is treated as
 * untrusted text throughout.
 */
export const advisorRequestSchema = z.object({
  question: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().max(500).optional(),
  ),
});

export type AdvisorRequestInput = z.infer<typeof advisorRequestSchema>;
