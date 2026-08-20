import Anthropic from "@anthropic-ai/sdk";
import {
  ASSESSMENT_TOOL_NAME,
  buildAssessmentToolSchema,
  buildUserContent,
} from "@/lib/ai/tool";
import {
  AssessmentModelError,
  type AssessmentModelInput,
  type AssessmentModelPort,
  type AssessmentModelResult,
} from "@/lib/ai/modelPort";

/** D2: Sonnet 5 is the default runtime assessment model; Opus 5 is used
 * only for an explicit technician escalation/re-assessment, never chosen
 * automatically. Haiku is never used for the assessment itself. */
export const STANDARD_MODEL_ID = "claude-sonnet-5";
export const ESCALATION_MODEL_ID = "claude-opus-5";

const MAX_TOKENS = 4096;

/**
 * Deliberately chosen, not left to SDK defaults (Phase 8). The reaper
 * (prisma/migrations/20260817000011_ai_assessment_reaper) sweeps a
 * `running` assessment after 5 minutes; this timeout is kept comfortably
 * under that so a genuinely stuck call fails here -- through the
 * executor's own `model_error` handling, which records the three
 * baseline safety warnings immediately -- rather than sitting until the
 * coarser reaper sweep catches it with no warnings at all (see the
 * reaper's known gap in docs/architecture/safety.md). `maxRetries` is
 * capped low: this call already costs tokens on every attempt, and a
 * schema/citation failure is a value returned by a successful HTTP call,
 * never a retryable transport error, so the SDK's retry budget is spent
 * only on genuine connection/5xx/429 failures.
 */
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AssessmentModelError("ANTHROPIC_API_KEY is not set");
    }
    client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  }
  return client;
}

/**
 * Server-only. Never constructed in a client component, never imported
 * outside lib/ai/*. The tool call is forced (`tool_choice: {type:"tool"}`)
 * and `strict: true` guarantees the response matches the schema Claude was
 * given -- this is what makes "the model always returns valid structured
 * output" a property of the API contract rather than of prompting.
 */
export class AnthropicAssessmentModel implements AssessmentModelPort {
  constructor(public readonly modelId: string) {}

  async run(input: AssessmentModelInput): Promise<AssessmentModelResult> {
    const started = Date.now();
    let response: Anthropic.Message;
    try {
      response = await getClient().messages.create({
        model: this.modelId,
        max_tokens: MAX_TOKENS,
        system: input.systemPrompt,
        tools: [
          {
            name: ASSESSMENT_TOOL_NAME,
            description:
              "Record a structured assessment of the provided job photographs.",
            input_schema: buildAssessmentToolSchema() as Anthropic.Tool.InputSchema,
            strict: true,
          },
        ],
        tool_choice: { type: "tool", name: ASSESSMENT_TOOL_NAME, disable_parallel_tool_use: true },
        messages: [
          {
            role: "user",
            content: [
              ...input.images.map(
                (img): Anthropic.ImageBlockParam => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.mediaType,
                    data: img.base64,
                  },
                }),
              ),
              { type: "text", text: buildUserContent(input.jobContext) },
            ],
          },
        ],
      });
    } catch (err) {
      throw new AssessmentModelError("Anthropic API request failed", err);
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new AssessmentModelError(
        `Model did not return a ${ASSESSMENT_TOOL_NAME} tool call (stop_reason=${response.stop_reason})`,
      );
    }

    return {
      payload: toolUse.input,
      rawResponse: response,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason ?? "unknown",
      latencyMs: Date.now() - started,
    };
  }
}
