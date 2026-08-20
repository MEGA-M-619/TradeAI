import { AdvisorGroundingError } from "@/lib/ai/advisor/port";
import {
  advisorResponseSchema,
  type AdvisorContext,
  type AdvisorResponse,
} from "@/lib/ai/advisor/schema";

/**
 * The gate every model response passes before anyone sees it.
 *
 * Two independent checks. First the Zod parse, which enforces shape and
 * strips anything the schema does not describe -- so a field the model
 * invented (a safety verdict, a confidence number, a price) never reaches
 * the UI even if the model emitted one. Then grounding: every id the
 * response cites must exist in the authoritative context, and the prose
 * must not contain a claim the model is not permitted to make.
 *
 * A failure discards the whole response rather than sanitising it. A
 * partially-trustworthy answer about electrical work is not worth
 * salvaging, and silently dropping the offending sentence would leave the
 * rest reading as though it had been verified.
 */

/**
 * Claims no model output may contain, checked case-insensitively against
 * every free-text field.
 *
 * Phrased to catch assertions rather than their negations: the safety
 * documentation itself has to be able to say "never certifies the
 * condition", and a blanket ban on the word "safe" would make honest
 * disclaimers impossible. These target the affirmative forms.
 */
const FORBIDDEN_CLAIMS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\b(?:is|are|it's|its|looks?|seems?|appears?)\s+safe\b/i,
    why: "asserts something is safe",
  },
  {
    pattern: /\bsafe\s+to\s+(?:touch|energi[sz]e|work|proceed|continue)\b/i,
    why: "asserts an action is safe",
  },
  {
    pattern: /\b(?:is|are|confirmed|verified)\s+de-?energi[sz]ed\b/i,
    why: "asserts a conductor is de-energized",
  },
  {
    pattern: /\b(?:is|are)\s+(?:code[- ])?compliant\b/i,
    why: "rules on code compliance",
  },
  {
    pattern: /\b(?:meets|complies with)\s+(?:the\s+)?(?:NEC|IEC|BS\s?7671|code)\b/i,
    why: "rules on code compliance",
  },
  {
    pattern: /\ball\s+clear\b/i,
    why: "declares an all-clear",
  },
];

/** Free text a STOP verdict makes unacceptable: the model must not point
 * the technician onward while work is blocked. */
const PROCEED_WHILE_STOPPED =
  /\b(?:you\s+can|you\s+may|go\s+ahead|carry\s+on|continue\s+working|proceed\s+with)\b/i;

function textFieldsOf(response: AdvisorResponse): string[] {
  return [
    response.assessment,
    ...response.evidence.map((e) => e.statement),
    ...response.likelyExplanations.flatMap((e) => [e.statement, e.reasoning]),
    ...response.contradictions,
    ...response.unknowns,
    ...(response.nextCheck
      ? [response.nextCheck.action, response.nextCheck.whyItMatters]
      : []),
    ...response.safetyNotes,
    ...(response.escalationReason ? [response.escalationReason] : []),
  ];
}

/**
 * Parses and grounds a raw model payload against the context it was given.
 * Throws AdvisorGroundingError listing every problem found, so a failure
 * is diagnosable rather than just "rejected".
 */
export function validateAdvisorResponse(
  payload: unknown,
  context: AdvisorContext,
): AdvisorResponse {
  const parsed = advisorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AdvisorGroundingError(
      "The advisor returned a malformed answer",
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  const response = parsed.data;
  const problems: string[] = [];

  // --- References must resolve against the authoritative context.
  const knownMeasurementIds = new Set(context.measurements.map((m) => m.id));
  const knownCauseIds = new Set(context.causes.map((c) => c.id));

  const citedIds = [
    ...response.evidence.flatMap((e) => e.citedMeasurementIds),
    ...response.likelyExplanations.flatMap((e) => e.citedMeasurementIds),
  ];
  for (const id of citedIds) {
    if (!knownMeasurementIds.has(id)) {
      problems.push(`cites measurement ${id}, which is not in this session`);
    }
  }
  for (const explanation of response.likelyExplanations) {
    if (explanation.causeId !== null && !knownCauseIds.has(explanation.causeId)) {
      problems.push(
        `references cause ${explanation.causeId}, which is not in this session`,
      );
    }
  }

  // --- Claims the model is never permitted to make.
  for (const text of textFieldsOf(response)) {
    for (const { pattern, why } of FORBIDDEN_CLAIMS) {
      if (pattern.test(text)) {
        problems.push(`${why}: "${truncate(text)}"`);
      }
    }
  }

  // --- The deterministic safety state wins, structurally.
  // The schema gives the model nowhere to state a safety verdict, so it
  // cannot overwrite one. This catches the remaining route: prose that
  // encourages proceeding while the Safety Engine says STOP.
  if (context.safety.state === "STOP") {
    for (const text of textFieldsOf(response)) {
      if (PROCEED_WHILE_STOPPED.test(text)) {
        problems.push(
          `suggests proceeding while the safety state is STOP: "${truncate(text)}"`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new AdvisorGroundingError(
      "The advisor's answer was not grounded in this session's facts",
      problems,
    );
  }

  return response;
}

function truncate(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
