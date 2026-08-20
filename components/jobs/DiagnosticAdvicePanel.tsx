"use client";

import { useState } from "react";
import {
  Card,
  Badge,
  type BadgeVariant,
  Button,
  Input,
  Spinner,
} from "@/components/ui";
import styles from "./DiagnosticAdvicePanel.module.css";

type Explanation = {
  statement: string;
  causeId: string | null;
  support: "well_supported" | "plausible" | "insufficient_evidence";
  reasoning: string;
  citedMeasurementIds: string[];
};

type Advice = {
  assessment: string;
  evidence: { statement: string; citedMeasurementIds: string[] }[];
  likelyExplanations: Explanation[];
  contradictions: string[];
  unknowns: string[];
  nextCheck: { action: string; whyItMatters: string } | null;
  safetyNotes: string[];
  recommendEscalation: boolean;
  escalationReason: string | null;
};

type AdviceResult = {
  advice: Advice;
  modelId: string;
  contextFingerprint: string;
};

const SUPPORT_DISPLAY: Record<
  Explanation["support"],
  { label: string; variant: BadgeVariant }
> = {
  well_supported: { label: "Well supported", variant: "success" },
  plausible: { label: "Plausible", variant: "info" },
  insufficient_evidence: { label: "Not enough evidence", variant: "warning" },
};

/**
 * The AI reasoning panel, rendered inside a diagnostic session.
 *
 * Deliberately not a chatbot: it has no conversation history, and every
 * request rebuilds the authoritative context server-side from current
 * state. An older answer can never become the basis for a newer one.
 *
 * It sits *below* the deterministic safety banner and never renders a
 * safety state of its own. The verdict the technician acts on comes from
 * the Safety Engine; this explains the situation around it.
 */
export function DiagnosticAdvicePanel({
  orgId,
  jobId,
  sessionId,
  /** Digest of the deterministic state as the page currently shows it --
   * readings, their evaluations, cause statuses and the safety verdict.
   * Recorded when advice is requested and compared afterwards, so
   * reasoning produced before a new reading is labelled stale rather than
   * silently presented as current. */
  stateKey,
}: {
  orgId: string;
  jobId: string;
  sessionId: string;
  stateKey: string;
}) {
  const [result, setResult] = useState<AdviceResult | null>(null);
  const [stateKeyAtRequest, setStateKeyAtRequest] = useState<string | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stale = result !== null && stateKeyAtRequest !== stateKey;

  async function ask() {
    // Guarded so a double tap cannot bill two calls.
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${sessionId}/advice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: question.trim() || undefined }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.error === "advisor_unavailable") {
          throw new Error(
            "AI assistance is unavailable right now. Everything else on this page still works.",
          );
        }
        if (body?.error === "advisor_ungrounded") {
          throw new Error(
            "The AI's answer did not match this job's recorded facts, so it was discarded.",
          );
        }
        if (response.status === 404) {
          throw new Error("This investigation could not be found.");
        }
        throw new Error("Could not get AI assistance. Try again.");
      }

      setResult(await response.json());
      setStateKeyAtRequest(stateKey);
    } catch (err) {
      setResult(null);
      setStateKeyAtRequest(null);
      setError(
        err instanceof Error ? err.message : "Could not get AI assistance.",
      );
    } finally {
      setLoading(false);
    }
  }

  const advice = result?.advice;

  return (
    <Card>
      <div className={styles.head}>
        <h3 className={styles.title}>AI reasoning</h3>
        <span className={styles.subtitle}>
          Explains the recorded evidence. It cannot change a measurement, a
          cause, or the safety verdict.
        </span>
      </div>

      <div className={styles.askRow}>
        <Input
          aria-label="Ask about this investigation"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Optional: what should I check next?"
          disabled={loading}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={ask}
          loading={loading}
          loadingText="Thinking..."
        >
          {result ? "Ask again" : "Ask AI"}
        </Button>
      </div>

      {loading && (
        <div className={styles.loading}>
          <Spinner /> <span>Reading the measurements and safety state...</span>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {advice && !loading && (
        <div className={styles.result}>
          {stale && (
            <p className={styles.stale}>
              Something changed since this was written — record it again to
              re-check against the current readings.
            </p>
          )}

          <section className={styles.block}>
            <h4 className={styles.blockTitle}>Assessment</h4>
            <p className={styles.body}>{advice.assessment}</p>
          </section>

          {advice.likelyExplanations.length > 0 && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>Likely explanations</h4>
              {advice.likelyExplanations.map((explanation, index) => (
                <div key={index} className={styles.explanation}>
                  <div className={styles.explanationHead}>
                    <span className={styles.explanationStatement}>
                      {explanation.statement}
                    </span>
                    <Badge variant={SUPPORT_DISPLAY[explanation.support].variant}>
                      {SUPPORT_DISPLAY[explanation.support].label}
                    </Badge>
                  </div>
                  <p className={styles.body}>{explanation.reasoning}</p>
                </div>
              ))}
            </section>
          )}

          {advice.evidence.length > 0 && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>Evidence</h4>
              <ul className={styles.list}>
                {advice.evidence.map((item, index) => (
                  <li key={index}>{item.statement}</li>
                ))}
              </ul>
            </section>
          )}

          {advice.contradictions.length > 0 && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>Conflicting evidence</h4>
              <ul className={styles.list}>
                {advice.contradictions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {advice.unknowns.length > 0 && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>What is uncertain</h4>
              <ul className={styles.list}>
                {advice.unknowns.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {advice.nextCheck && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>Next check</h4>
              <p className={styles.body}>{advice.nextCheck.action}</p>
              <p className={styles.why}>{advice.nextCheck.whyItMatters}</p>
            </section>
          )}

          {advice.safetyNotes.length > 0 && (
            <section className={styles.block}>
              <h4 className={styles.blockTitle}>On the safety state</h4>
              <ul className={styles.list}>
                {advice.safetyNotes.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {advice.recommendEscalation && (
            <p className={styles.escalate}>
              Recommends a second opinion
              {advice.escalationReason ? `: ${advice.escalationReason}` : "."}
            </p>
          )}

          <p className={styles.provenance}>
            Generated by {result.modelId}. Reasoning only — the safety verdict
            above comes from TradeAI&apos;s own checks.
          </p>
        </div>
      )}
    </Card>
  );
}
