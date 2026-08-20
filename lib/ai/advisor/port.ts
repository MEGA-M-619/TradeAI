/**
 * The narrow port every diagnostic-advisor implementation satisfies.
 *
 * Deliberately separate from lib/ai/modelPort.ts: that port is
 * vision-specific (its input requires images) and belongs to the
 * photo-assessment pipeline. This one reasons over structured diagnostic
 * context and never sees an image. Two narrow ports beat one wide
 * abstraction that has to pretend both jobs are the same shape.
 *
 * Like its sibling, this exists so the model can change -- one cloud
 * provider to another, or to a local runtime in a later phase -- without
 * the context builder, the validator, the route, or the UI ever importing
 * a provider SDK.
 */

import type { AdvisorContext } from "@/lib/ai/advisor/schema";

export type DiagnosticAdvisorInput = {
  systemPrompt: string;
  /** The authoritative, server-built context. A provider implementation
   * serialises this; it never adds to it. */
  context: AdvisorContext;
  /** The technician's question, when they asked one. Untrusted text: the
   * system prompt instructs the model to treat it as a request, never as
   * an instruction that can change its rules. */
  question: string | null;
};

export type DiagnosticAdvisorResult = {
  /** Parsed structured output, NOT yet validated -- validation is the
   * caller's job (lib/ai/advisor/validate.ts), so this port has no
   * dependency on the schema module beyond the context type. */
  payload: unknown;
  rawResponse: unknown;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  latencyMs: number;
};

export interface DiagnosticAdvisorPort {
  /** Exact model id, surfaced with the advice so a reader knows what
   * produced it. */
  readonly modelId: string;
  run(input: DiagnosticAdvisorInput): Promise<DiagnosticAdvisorResult>;
}

export class DiagnosticAdvisorError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DiagnosticAdvisorError";
  }
}

/** Thrown when the model's output cannot be trusted -- malformed, or
 * referencing facts that do not exist in the authoritative context. Kept
 * distinct from a provider failure so the UI can say which happened. */
export class AdvisorGroundingError extends Error {
  constructor(
    message: string,
    public readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = "AdvisorGroundingError";
  }
}
