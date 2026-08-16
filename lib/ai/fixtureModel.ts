import type {
  AssessmentModelInput,
  AssessmentModelPort,
  AssessmentModelResult,
} from "@/lib/ai/modelPort";

/**
 * A no-network model implementation for tests and the evaluation harness.
 * Recorded/curated payloads are replayed instead of calling Anthropic, so
 * the executor's own logic (validation, citation resolution, safety
 * rules, persistence) can be exercised deterministically and without cost
 * -- this is what keeps that logic in the normal CI suite while real
 * model calls stay opt-in only (npm run test:security, npm run
 * eval:assessment).
 */
export class FixtureAssessmentModel implements AssessmentModelPort {
  readonly modelId: string;
  private callCount = 0;

  constructor(
    private readonly resolver: (
      input: AssessmentModelInput,
      callIndex: number,
    ) => AssessmentModelResult | Promise<AssessmentModelResult>,
    modelId = "fixture-model",
  ) {
    this.modelId = modelId;
  }

  /** Always returns the same payload, wrapped with plausible usage/stop
   * metadata -- the common case for a single-assertion test. */
  static withPayload(payload: unknown, modelId?: string): FixtureAssessmentModel {
    return new FixtureAssessmentModel(
      () => makeResult(payload),
      modelId,
    );
  }

  /** Simulates a provider-level failure (network error, 5xx, timeout). */
  static throwing(error: Error, modelId?: string): FixtureAssessmentModel {
    return new FixtureAssessmentModel(() => {
      throw error;
    }, modelId);
  }

  async run(
    input: AssessmentModelInput,
  ): Promise<AssessmentModelResult> {
    const result = await this.resolver(input, this.callCount);
    this.callCount += 1;
    return result;
  }
}

export function makeResult(
  payload: unknown,
  overrides: Partial<Omit<AssessmentModelResult, "payload">> = {},
): AssessmentModelResult {
  return {
    payload,
    rawResponse: { fixture: true, payload },
    usage: { inputTokens: 500, outputTokens: 300 },
    stopReason: "tool_use",
    latencyMs: 1,
    ...overrides,
  };
}
