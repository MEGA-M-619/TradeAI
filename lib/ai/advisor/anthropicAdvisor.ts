import Anthropic from "@anthropic-ai/sdk";
import {
  DiagnosticAdvisorError,
  type DiagnosticAdvisorInput,
  type DiagnosticAdvisorPort,
  type DiagnosticAdvisorResult,
} from "@/lib/ai/advisor/port";
import {
  ADVISOR_TOOL_NAME,
  buildAdvisorToolSchema,
} from "@/lib/ai/advisor/schema";
import { buildAdvisorUserContent } from "@/lib/ai/advisor/prompt";

/**
 * The Anthropic implementation of the advisor port. This is the only file
 * in the advisor stack that imports a provider SDK -- swapping providers
 * means adding a sibling of this file, not touching the context builder,
 * the validator, the route, or the UI.
 *
 * Model choice is server-side configuration, never a client input: a
 * caller cannot ask for a more expensive model.
 */

/** Overridable so a deployment can move models without a code change. */
export const DEFAULT_ADVISOR_MODEL_ID =
  process.env.TRADEAI_ADVISOR_MODEL ?? "claude-sonnet-5";

const MAX_TOKENS = 2048;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new DiagnosticAdvisorError(
      "ANTHROPIC_API_KEY is not configured; the diagnostic advisor is unavailable",
    );
  }
  client = new Anthropic({ apiKey });
  return client;
}

export class AnthropicDiagnosticAdvisor implements DiagnosticAdvisorPort {
  readonly modelId: string;

  constructor(modelId: string = DEFAULT_ADVISOR_MODEL_ID) {
    this.modelId = modelId;
  }

  async run(input: DiagnosticAdvisorInput): Promise<DiagnosticAdvisorResult> {
    const startedAt = Date.now();
    let response;
    try {
      response = await getClient().messages.create({
        model: this.modelId,
        max_tokens: MAX_TOKENS,
        system: input.systemPrompt,
        // Forced structured output: the schema is an API constraint, not
        // a request expressed in prose the model may drift from.
        tools: [
          {
            name: ADVISOR_TOOL_NAME,
            description:
              "Record your diagnostic reasoning over the supplied TradeAI context.",
            input_schema: buildAdvisorToolSchema() as never,
          },
        ],
        tool_choice: {
          type: "tool",
          name: ADVISOR_TOOL_NAME,
          disable_parallel_tool_use: true,
        },
        messages: [
          {
            role: "user",
            content: buildAdvisorUserContent(input.context, input.question),
          },
        ],
      });
    } catch (error) {
      throw new DiagnosticAdvisorError(
        "The diagnostic advisor could not be reached",
        error,
      );
    }

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new DiagnosticAdvisorError(
        "The advisor returned no structured answer",
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
      latencyMs: Date.now() - startedAt,
    };
  }
}
