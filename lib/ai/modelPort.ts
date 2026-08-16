/**
 * The narrow port every assessment model implementation satisfies.
 * Deliberately not a general-purpose LLM abstraction -- it exists so the
 * assessment model can change (Sonnet 5 -> a future model, or a fixture
 * for tests) without the executor, the safety layer, or persistence ever
 * importing a provider SDK. See lib/ai/anthropicModel.ts and
 * lib/ai/fixtureModel.ts for the two implementations.
 */

export type AssessmentImageInput = {
  /** Ordinal ref shown to the model, e.g. "E1" -- never a database id. */
  ref: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
};

export type AssessmentModelInput = {
  systemPrompt: string;
  jobContext: { title: string; problemDescription: string | null };
  images: AssessmentImageInput[];
};

export type AssessmentModelResult = {
  /** Parsed tool-call input, NOT yet validated against modelOutputSchema
   * -- validation is the caller's responsibility (lib/ai/executor.ts), so
   * this port has no dependency on the validation module. */
  payload: unknown;
  /** Verbatim provider response, stored as-is for provenance/debugging.
   * Never rendered to end users directly. */
  rawResponse: unknown;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  latencyMs: number;
};

export interface AssessmentModelPort {
  /** Exact model ID, persisted verbatim on every assessment row. */
  readonly modelId: string;
  run(input: AssessmentModelInput): Promise<AssessmentModelResult>;
}

export class AssessmentModelError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AssessmentModelError";
  }
}
