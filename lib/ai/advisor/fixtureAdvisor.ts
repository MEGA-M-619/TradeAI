import {
  DiagnosticAdvisorError,
  type DiagnosticAdvisorInput,
  type DiagnosticAdvisorPort,
  type DiagnosticAdvisorResult,
} from "@/lib/ai/advisor/port";

/**
 * A deterministic stand-in for the real provider, used by tests. It
 * replays a payload the test supplies -- including a deliberately
 * malformed or ungrounded one -- so the validator and the failure paths
 * can be exercised without a network call or an API key.
 *
 * It also records what it was asked, which is how the context-boundary
 * tests assert that the model was never told about another tenant's data
 * and that the safety verdict actually reached it.
 */
export class FixtureDiagnosticAdvisor implements DiagnosticAdvisorPort {
  readonly modelId = "fixture-advisor";

  lastInput: DiagnosticAdvisorInput | null = null;
  callCount = 0;

  private constructor(
    private readonly payload: unknown,
    private readonly failure: Error | null,
  ) {}

  static withPayload(payload: unknown): FixtureDiagnosticAdvisor {
    return new FixtureDiagnosticAdvisor(payload, null);
  }

  /** Simulates a provider outage, timeout, or rate limit. */
  static failing(
    message = "provider unavailable",
  ): FixtureDiagnosticAdvisor {
    return new FixtureDiagnosticAdvisor(
      null,
      new DiagnosticAdvisorError(message),
    );
  }

  async run(input: DiagnosticAdvisorInput): Promise<DiagnosticAdvisorResult> {
    this.callCount += 1;
    this.lastInput = input;
    if (this.failure) throw this.failure;
    return {
      payload: this.payload,
      rawResponse: { fixture: true },
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "tool_use",
      latencyMs: 0,
    };
  }
}

/** A well-formed response shaped for a given context, so tests that are
 * not about the response body do not have to hand-write one. */
export function validAdvisorPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assessment: "The recorded readings are consistent with the symptom.",
    evidence: [],
    likelyExplanations: [],
    contradictions: [],
    unknowns: ["The upstream supply state has not been measured."],
    nextCheck: {
      action: "Measure voltage at the supply side of the breaker.",
      whyItMatters: "It separates a supply fault from a downstream fault.",
    },
    safetyNotes: ["The safety check is waiting on the verifications listed."],
    recommendEscalation: false,
    escalationReason: null,
    ...overrides,
  };
}
