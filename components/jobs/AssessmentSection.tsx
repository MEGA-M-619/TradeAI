"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, Badge, ErrorState, EmptyState, useToast } from "@/components/ui";
import type { EvidenceItem } from "./EvidenceSection";
import styles from "./AssessmentSection.module.css";

type Confidence = "low" | "medium" | "high";
type FindingKind = "observation" | "hypothesis";
type SafetySeverity = "advisory" | "mandatory" | "stop_work";
type VerdictKind = "confirmed" | "rejected" | "amended" | "unresolved";
type AssessmentStatus = "queued" | "running" | "complete" | "insufficient_evidence" | "failed";

export type AssessmentSummary = {
  id: string;
  version: number;
  status: AssessmentStatus;
  modelTier: "standard" | "escalation";
  createdAt: string;
};

type Citation = { evidenceId: string };
type FindingTest = { test: string; rulesInIfPositive: string; rulesOutIfNegative: string };
type Verdict = { verdict: VerdictKind; note: string | null };
type Finding = {
  id: string;
  kind: FindingKind;
  ref: string;
  statement: string;
  confidence: Confidence;
  rationale: string;
  whatWouldChangeMyMind: string | null;
  safetyCategories: string[];
  citations: Citation[];
  tests: FindingTest[];
  verdict: Verdict | null;
};
type Question = { id: string; question: string; whyItMatters: string; answersWouldRuleIn: string[] };
type SafetyWarning = { id: string; ruleId: string; severity: SafetySeverity; message: string };

type AssessmentDetail = AssessmentSummary & {
  insufficientReason: string | null;
  failureCategory: string | null;
  errorMessage: string | null;
  findings: Finding[];
  questions: Question[];
  safetyWarnings: SafetyWarning[];
};

const IN_FLIGHT_STATUSES: AssessmentStatus[] = ["queued", "running"];
const POLL_INTERVAL_MS = 3000;

const FAILURE_MESSAGES: Record<string, string> = {
  quota_exceeded: "The monthly assessment limit for this organization was reached.",
  sha_mismatch: "One of the selected photos could not be verified and the assessment was stopped.",
  model_error: "The assessment service could not be reached. Try again in a moment.",
  schema_violation: "The assessment response was malformed and could not be used.",
  citation_violation: "The assessment cited evidence that was not part of this request and was discarded.",
  timeout: "The assessment took too long and was stopped.",
  unknown: "The assessment could not be completed.",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };
const SEVERITY_VARIANT: Record<SafetySeverity, "danger" | "warning" | "neutral"> = {
  stop_work: "danger",
  mandatory: "warning",
  advisory: "neutral",
};
const SEVERITY_LABEL: Record<SafetySeverity, string> = {
  stop_work: "Stop work",
  mandatory: "Mandatory",
  advisory: "Advisory",
};

export function AssessmentSection({
  orgId,
  jobId,
  evidence,
  initialAssessments,
  maxImages,
}: {
  orgId: string;
  jobId: string;
  evidence: EvidenceItem[];
  initialAssessments: AssessmentSummary[];
  maxImages: number;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [summaries, setSummaries] = useState(initialAssessments);
  const latest = summaries[0] ?? null;

  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [escalate, setEscalate] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const fetchDetail = useCallback(
    async (assessmentId: string) => {
      const res = await fetch(`/api/orgs/${orgId}/jobs/${jobId}/assessments/${assessmentId}`);
      if (!res.ok) {
        setDetailError("Could not load this assessment.");
        return;
      }
      const body = await res.json();
      setDetail(body.assessment);
      setDetailError(null);
    },
    [orgId, jobId],
  );

  const latestId = latest?.id ?? null;
  useEffect(() => {
    async function load() {
      if (!latestId) {
        setDetail(null);
        return;
      }
      await fetchDetail(latestId);
    }
    load();
  }, [latestId, fetchDetail]);

  // Poll while the shown assessment is still in flight.
  useEffect(() => {
    if (!detail || !IN_FLIGHT_STATUSES.includes(detail.status)) return;
    pollTimer.current = setTimeout(async () => {
      await fetchDetail(detail.id);
      // Reflect the (possibly now-terminal) status in the summary list too.
      setSummaries((prev) =>
        prev.map((s) => (s.id === detail.id ? { ...s, status: detail.status } : s)),
      );
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [detail, fetchDetail]);

  function toggleEvidence(id: string) {
    setSelectedEvidenceIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxImages) return prev;
      return [...prev, id];
    });
  }

  async function handleRequestAssessment() {
    setRequesting(true);
    setRequestError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/jobs/${jobId}/assessments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidenceIds: selectedEvidenceIds, escalate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.error === "quota_exceeded") {
          const resetsAt = body.resetsAt ? new Date(body.resetsAt).toLocaleDateString() : "next month";
          throw new Error(`This organization's monthly assessment limit has been reached. Resets ${resetsAt}.`);
        }
        if (body?.error === "invalid_evidence") {
          throw new Error("One or more selected photos are no longer available. Refresh and try again.");
        }
        throw new Error("Could not start the assessment.");
      }
      const { assessment } = await res.json();
      setSummaries((prev) => [
        { id: assessment.id, version: assessment.version, status: assessment.status, modelTier: assessment.modelTier, createdAt: assessment.createdAt },
        ...prev,
      ]);
      setPickerOpen(false);
      setSelectedEvidenceIds([]);
      setEscalate(false);
      showToast("Assessment requested");
      router.refresh();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : "Could not start the assessment.");
    } finally {
      setRequesting(false);
    }
  }

  async function handleVerdict(findingId: string, verdict: VerdictKind) {
    if (!detail) return;
    const res = await fetch(
      `/api/orgs/${orgId}/jobs/${jobId}/assessments/${detail.id}/findings/${findingId}/verdict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict }),
      },
    );
    if (!res.ok) {
      showToast("Could not save that verdict", "error");
      return;
    }
    const { verdict: saved } = await res.json();
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            findings: prev.findings.map((f) =>
              f.id === findingId ? { ...f, verdict: { verdict: saved.verdict, note: saved.note } } : f,
            ),
          }
        : prev,
    );
  }

  function evidenceThumb(evidenceId: string): EvidenceItem | undefined {
    return evidence.find((e) => e.id === evidenceId);
  }

  const atCap = selectedEvidenceIds.length >= maxImages;

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>AI Assessment</h2>
        {!pickerOpen && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPickerOpen(true)}
            disabled={evidence.length === 0}
          >
            {latest ? "Request new assessment" : "Request assessment"}
          </Button>
        )}
      </div>

      {evidence.length === 0 && !latest && (
        <EmptyState
          title="Add photos before requesting an assessment"
          description="The assessment reviews the job's photos -- add at least one in the Photos section above."
        />
      )}

      {pickerOpen && (
        <Card className={styles.pickerCard}>
          <p className={styles.pickerTitle}>
            Choose up to {maxImages} photos ({selectedEvidenceIds.length} of {maxImages} selected)
          </p>
          <ul className={styles.pickerGrid}>
            {evidence.map((item) => {
              const selected = selectedEvidenceIds.includes(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`${styles.pickerTile} ${selected ? styles.pickerTileSelected : ""}`}
                    onClick={() => toggleEvidence(item.id)}
                    disabled={!selected && atCap}
                    aria-pressed={selected}
                  >
                    {item.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt="" className={styles.pickerImg} />
                    ) : (
                      <span className={styles.pickerImgMissing}>Unavailable</span>
                    )}
                    {selected && <span className={styles.pickerCheck} aria-hidden="true">✓</span>}
                  </button>
                </li>
              );
            })}
          </ul>

          <label className={styles.escalateRow}>
            <input
              type="checkbox"
              checked={escalate}
              onChange={(e) => setEscalate(e.target.checked)}
            />
            Use the higher-capability model for this assessment
          </label>

          {requestError && <ErrorState title="Could not request assessment" description={requestError} />}

          <div className={styles.pickerActions}>
            <Button type="button" variant="ghost" onClick={() => { setPickerOpen(false); setSelectedEvidenceIds([]); setRequestError(null); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleRequestAssessment}
              loading={requesting}
              loadingText="Starting..."
              disabled={selectedEvidenceIds.length === 0}
            >
              Request assessment
            </Button>
          </div>
        </Card>
      )}

      {latest && !pickerOpen && (
        <Card>
          <div className={styles.versionRow}>
            <span className={styles.versionLabel}>Version {latest.version}</span>
            {detail?.modelTier === "escalation" && <Badge variant="info" dot={false}>Higher-capability model</Badge>}
          </div>

          {detailError && <ErrorState title="Could not load assessment" description={detailError} />}

          {detail && IN_FLIGHT_STATUSES.includes(detail.status) && (
            <div className={styles.inFlight}>
              <span className={styles.spinner} aria-hidden="true" />
              <p>{detail.status === "queued" ? "Waiting to start..." : "Reviewing photos..."}</p>
            </div>
          )}

          {detail?.status === "failed" && (
            <ErrorState
              title="Assessment could not be completed"
              description={FAILURE_MESSAGES[detail.failureCategory ?? "unknown"] ?? FAILURE_MESSAGES.unknown}
            />
          )}

          {detail?.status === "insufficient_evidence" && (
            <div className={styles.insufficient}>
              <p className={styles.insufficientTitle}>Not enough information in these photos</p>
              <p>{detail.insufficientReason}</p>
            </div>
          )}

          {detail?.status === "complete" && (
            <div className={styles.results}>
              {detail.safetyWarnings.length > 0 && (
                <div className={styles.safetyList}>
                  {detail.safetyWarnings.map((w) => (
                    <div key={w.id} className={`${styles.safetyBanner} ${styles[`severity_${w.severity}`]}`}>
                      <Badge variant={SEVERITY_VARIANT[w.severity]}>{SEVERITY_LABEL[w.severity]}</Badge>
                      <p>{w.message}</p>
                    </div>
                  ))}
                </div>
              )}

              {detail.findings.length === 0 && (
                <p className={styles.noFindings}>No specific observations were recorded.</p>
              )}

              {detail.findings.map((finding) => (
                <div
                  key={finding.id}
                  className={`${styles.finding} ${finding.kind === "hypothesis" ? styles.findingHypothesis : styles.findingObservation}`}
                >
                  <div className={styles.findingHeader}>
                    <span className={styles.findingKind}>
                      {finding.kind === "hypothesis" ? "AI hypothesis" : "AI observation"}
                    </span>
                    <span className={styles.findingConfidence}>{CONFIDENCE_LABEL[finding.confidence]}</span>
                  </div>
                  <p className={styles.findingStatement}>{finding.statement}</p>
                  <p className={styles.findingRationale}>{finding.rationale}</p>

                  {finding.citations.length > 0 && (
                    <div className={styles.citations}>
                      {finding.citations.map((c) => {
                        const thumb = evidenceThumb(c.evidenceId);
                        return thumb?.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={c.evidenceId} src={thumb.url} alt="Cited photo" className={styles.citationThumb} />
                        ) : null;
                      })}
                    </div>
                  )}

                  {finding.kind === "hypothesis" && (
                    <div className={styles.hypothesisExtra}>
                      {finding.whatWouldChangeMyMind && (
                        <p className={styles.wouldChangeMind}>
                          <strong>Would reconsider if:</strong> {finding.whatWouldChangeMyMind}
                        </p>
                      )}
                      {finding.tests.length > 0 && (
                        <ul className={styles.testList}>
                          {finding.tests.map((t, i) => (
                            <li key={i}>
                              <strong>Test:</strong> {t.test}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className={styles.verdictRow}>
                    {finding.verdict ? (
                      <Badge
                        variant={
                          finding.verdict.verdict === "confirmed" ? "success" :
                          finding.verdict.verdict === "rejected" ? "danger" :
                          finding.verdict.verdict === "amended" ? "warning" : "neutral"
                        }
                      >
                        Technician: {finding.verdict.verdict}
                      </Badge>
                    ) : (
                      <div className={styles.verdictButtons}>
                        <Button type="button" variant="secondary" size="sm" onClick={() => handleVerdict(finding.id, "confirmed")}>
                          Confirm
                        </Button>
                        <Button type="button" variant="danger" size="sm" onClick={() => handleVerdict(finding.id, "rejected")}>
                          Reject
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => handleVerdict(finding.id, "amended")}>
                          Amend
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {detail.questions.length > 0 && (
                <div className={styles.questions}>
                  <p className={styles.questionsTitle}>Follow-up questions</p>
                  {detail.questions.map((q) => (
                    <div key={q.id} className={styles.question}>
                      <p className={styles.questionText}>{q.question}</p>
                      <p className={styles.questionWhy}>{q.whyItMatters}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
