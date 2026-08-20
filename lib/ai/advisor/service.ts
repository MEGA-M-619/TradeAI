import type { TenantTxClient } from "@/lib/db/tenantContext";
import { buildAdvisorContext } from "@/lib/ai/advisor/context";
import {
  AdvisorGroundingError,
  DiagnosticAdvisorError,
  type DiagnosticAdvisorPort,
} from "@/lib/ai/advisor/port";
import { AnthropicDiagnosticAdvisor } from "@/lib/ai/advisor/anthropicAdvisor";
import { ADVISOR_SYSTEM_PROMPT } from "@/lib/ai/advisor/prompt";
import {
  ADVISOR_PROMPT_VERSION,
  ADVISOR_SCHEMA_VERSION,
  type AdvisorResponse,
} from "@/lib/ai/advisor/schema";
import { validateAdvisorResponse } from "@/lib/ai/advisor/validate";

/**
 * Orchestrates one piece of advice: build the authoritative context, ask
 * the model, validate what comes back, and hand over a result that is
 * either trustworthy or an explicit failure.
 *
 * Every failure mode is a value, not an exception thrown at the route:
 * the AI is an enhancement, and a provider outage must leave the
 * deterministic workflow untouched. The route turns these into a response
 * the UI can explain without implying anything about the electrical
 * situation.
 */

export type AdvisorOutcome =
  | {
      status: "ok";
      advice: AdvisorResponse;
      modelId: string;
      /** The deterministic state this reasoning was produced from. The UI
       * compares it against the current state to detect staleness. */
      contextFingerprint: string;
      promptVersion: string;
      schemaVersion: string;
      /** Echoed back so the UI can show the verdict the model was told
       * about, and so a reader can see the two agree. */
      safetyState: string;
    }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string }
  | { status: "ungrounded"; reason: string; problems: readonly string[] };

export type AdvisorFactory = () => DiagnosticAdvisorPort;

const defaultAdvisorFactory: AdvisorFactory = () =>
  new AnthropicDiagnosticAdvisor();

/**
 * `advisorFactory` is injectable for tests only. It is never reachable
 * from a request: the route calls this with no factory, so a caller
 * cannot select a model or substitute a provider.
 */
export async function requestDiagnosticAdvice(
  tx: TenantTxClient,
  orgId: string,
  jobId: string,
  sessionId: string,
  question: string | null,
  advisorFactory: AdvisorFactory = defaultAdvisorFactory,
): Promise<AdvisorOutcome> {
  const built = await buildAdvisorContext(tx, orgId, jobId, sessionId);
  if (!built) return { status: "not_found" };

  const { context, fingerprint } = built;

  let advisor: DiagnosticAdvisorPort;
  try {
    advisor = advisorFactory();
  } catch (error) {
    // Most commonly a missing API key. Reported as unavailable rather
    // than as an error, because nothing is wrong with the job.
    return {
      status: "unavailable",
      reason:
        error instanceof DiagnosticAdvisorError
          ? error.message
          : "The diagnostic advisor is not configured",
    };
  }

  let result;
  try {
    result = await advisor.run({
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      context,
      question,
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof DiagnosticAdvisorError
          ? error.message
          : "The diagnostic advisor could not be reached",
    };
  }

  try {
    const advice = validateAdvisorResponse(result.payload, context);
    return {
      status: "ok",
      advice,
      modelId: advisor.modelId,
      contextFingerprint: fingerprint,
      promptVersion: ADVISOR_PROMPT_VERSION,
      schemaVersion: ADVISOR_SCHEMA_VERSION,
      safetyState: context.safety.state,
    };
  } catch (error) {
    if (error instanceof AdvisorGroundingError) {
      return {
        status: "ungrounded",
        reason: error.message,
        problems: error.problems,
      };
    }
    throw error;
  }
}
