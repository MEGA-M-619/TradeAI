"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  Badge,
  type BadgeVariant,
  FormField,
  Input,
  Select,
  Textarea,
  Button,
  EmptyState,
  ErrorState,
  Spinner,
  useToast,
} from "@/components/ui";
import type { MeasurementItem } from "./MeasurementsSection";
import { DiagnosticAdvicePanel } from "./DiagnosticAdvicePanel";
import styles from "./DiagnosticsSection.module.css";

export type DiagnosticSessionSummary = {
  id: string;
  symptom: string;
  status: "open" | "investigating" | "diagnosed" | "abandoned";
  createdAt: string;
};

type CandidateCause = {
  id: string;
  statement: string;
  status: "candidate" | "confirmed" | "ruled_out";
  recommendedNextTest: string | null;
  resolvingMeasurementId: string | null;
};

type SafetyFinding = {
  ruleId: string;
  state: string;
  message: string;
  verify: string;
};

type SafetyEvaluation = {
  state: "STOP" | "INSUFFICIENT_INFORMATION" | "PROCEED_WITH_PRECAUTIONS";
  rulesetVersion: string;
  precautions: { id: string; message: string }[];
  findings: SafetyFinding[];
  firedRuleIds: string[];
  verifications: string[];
  unknownFacts: string[];
};

type SessionDetail = {
  session: DiagnosticSessionSummary & { causes: CandidateCause[] };
  safety: SafetyEvaluation;
};

/**
 * How each safety state presents. Read-only: the state is computed
 * server-side by lib/safety/evaluate.ts and this maps it to a banner.
 * Nothing here can weaken, downgrade, or dismiss a verdict.
 *
 * Note the floor state is not styled as an all-clear. It means no rule
 * escalated, which is a statement about what the system knows -- the
 * precautions still apply and are always shown.
 */
const SAFETY_DISPLAY: Record<
  SafetyEvaluation["state"],
  { label: string; variant: BadgeVariant; tone: string; headline: string }
> = {
  STOP: {
    label: "Stop",
    variant: "danger",
    tone: styles.toneStop,
    headline: "Do not proceed on this circuit",
  },
  INSUFFICIENT_INFORMATION: {
    label: "Not enough information",
    variant: "warning",
    tone: styles.toneUnknown,
    headline: "More information is needed before this can be assessed",
  },
  PROCEED_WITH_PRECAUTIONS: {
    label: "Proceed with precautions",
    variant: "neutral",
    tone: styles.toneFloor,
    headline: "No blocking condition found — standard precautions apply",
  },
};

const CAUSE_STATUS_DISPLAY: Record<
  CandidateCause["status"],
  { label: string; variant: BadgeVariant }
> = {
  candidate: { label: "Candidate", variant: "info" },
  confirmed: { label: "Confirmed", variant: "success" },
  ruled_out: { label: "Ruled out", variant: "neutral" },
};

const SESSION_STATUS_DISPLAY: Record<
  DiagnosticSessionSummary["status"],
  { label: string; variant: BadgeVariant }
> = {
  open: { label: "Open", variant: "info" },
  investigating: { label: "Investigating", variant: "info" },
  diagnosed: { label: "Diagnosed", variant: "success" },
  abandoned: { label: "Abandoned", variant: "neutral" },
};

export function DiagnosticsSection({
  orgId,
  jobId,
  sessions: initialSessions,
  measurements,
}: {
  orgId: string;
  jobId: string;
  sessions: DiagnosticSessionSummary[];
  measurements: MeasurementItem[];
}) {
  const { showToast } = useToast();

  const [sessions, setSessions] = useState(initialSessions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSessions[0]?.id ?? null,
  );
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by any mutation to re-fetch the session and, with it, a
   * freshly computed safety verdict. The verdict is derived on read, so
   * it must never be reused across a write. */
  const [reloadKey, setReloadKey] = useState(0);

  const [symptom, setSymptom] = useState("");
  const [creating, setCreating] = useState(false);
  const [startOpen, setStartOpen] = useState(false);

  const [causeStatement, setCauseStatement] = useState("");
  const [causeNextTest, setCauseNextTest] = useState("");
  const [addingCause, setAddingCause] = useState(false);
  const [busyCauseId, setBusyCauseId] = useState<string | null>(null);

  // Every state update happens in an async callback rather than
  // synchronously in the effect body, so selecting a session does not
  // trigger a cascading render.
  useEffect(() => {
    if (!selectedId) return;

    fetch(`/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${selectedId}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "That diagnostic session could not be found."
              : "Could not load the diagnostic session.",
          );
        }
        return (await response.json()) as SessionDetail;
      })
      .then((data) => {
        setDetail(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not load the session.",
        );
      });
    // Deliberately no cancellation flag. A cleanup that aborts the only
    // in-flight request leaves the section stuck on its loading state if
    // the effect tears down for any reason other than a new selection --
    // and a safety verdict that never appears is worse than one that
    // appears a moment late. A response for a superseded selection is
    // simply overwritten by the next one.
  }, [selectedId, orgId, jobId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const loading = selectedId !== null && detail === null && error === null;

  async function handleCreateSession(event: React.FormEvent) {
    event.preventDefault();
    if (!symptom.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/diagnostics`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symptom: symptom.trim() }),
        },
      );
      if (!response.ok) throw new Error("Could not start that investigation.");
      const { session } = await response.json();
      setSessions((current) => [session, ...current]);
      setSelectedId(session.id);
      setSymptom("");
      setStartOpen(false);
      showToast("Investigation started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start.");
    } finally {
      setCreating(false);
    }
  }

  async function handleAddCause(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !causeStatement.trim()) return;
    setAddingCause(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${selectedId}/causes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            statement: causeStatement.trim(),
            recommendedNextTest: causeNextTest.trim() || undefined,
          }),
        },
      );
      if (!response.ok) throw new Error("Could not add that possible cause.");
      setCauseStatement("");
      setCauseNextTest("");
      reload();
      showToast("Possible cause added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add cause.");
    } finally {
      setAddingCause(false);
    }
  }

  async function patchCause(
    causeId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    if (!selectedId) return;
    setBusyCauseId(causeId);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/diagnostics/${selectedId}/causes/${causeId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload?.error === "cause_already_confirmed") {
          throw new Error(
            "Another cause on this investigation is already confirmed. Rule that one out first.",
          );
        }
        if (payload?.error === "not_found" && payload.field === "measurement") {
          throw new Error("That reading does not belong to this job.");
        }
        throw new Error("Could not update that cause.");
      }
      reload();
      showToast(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update cause.");
    } finally {
      setBusyCauseId(null);
    }
  }

  const safety = detail?.safety;
  const safetyDisplay = safety ? SAFETY_DISPLAY[safety.state] : null;

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Diagnosis &amp; safety</h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setStartOpen((open) => !open)}
        >
          {startOpen ? "Cancel" : "Start investigation"}
        </Button>
      </div>

      {startOpen && (
        <Card>
          <FormField label="What is the symptom?" htmlFor="d-symptom" required>
            <Textarea
              id="d-symptom"
              value={symptom}
              onChange={(e) => setSymptom(e.target.value)}
              placeholder="e.g. Breaker trips within 5 seconds of reset"
            />
          </FormField>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleCreateSession}
              loading={creating}
              loadingText="Starting..."
              disabled={!symptom.trim()}
            >
              Start
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <div className={styles.errorSlot}>
          <ErrorState title="Something went wrong" description={error} />
        </div>
      )}

      {sessions.length === 0 ? (
        <EmptyState
          title="No investigation yet"
          description="Start one to track what you suspect, what you have ruled out, and what to check next."
        />
      ) : (
        <>
          {sessions.length > 1 && (
            <FormField label="Investigation" htmlFor="d-session">
              <Select
                id="d-session"
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value || null)}
              >
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.symptom}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {loading && (
            <Card>
              <div className={styles.loading}>
                <Spinner /> <span>Checking safety and diagnosis...</span>
              </div>
            </Card>
          )}

          {detail && !loading && (
            <>
              {/* Safety comes first, before any diagnostic content. If the
                  engine says stop, that must be the first thing read --
                  never something found after scrolling past causes. */}
              {safety && safetyDisplay && (
                <div
                  className={`${styles.safetyBanner} ${safetyDisplay.tone}`}
                  role={safety.state === "STOP" ? "alert" : "status"}
                >
                  <div className={styles.safetyHead}>
                    <Badge variant={safetyDisplay.variant}>
                      {safetyDisplay.label}
                    </Badge>
                    <span className={styles.safetyHeadline}>
                      {safetyDisplay.headline}
                    </span>
                  </div>

                  {safety.verifications.length > 0 && (
                    <div className={styles.safetyBlock}>
                      <h3 className={styles.safetySubhead}>
                        Verify before going further
                      </h3>
                      <ul className={styles.safetyList}>
                        {safety.verifications.map((verification) => (
                          <li key={verification}>{verification}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {safety.findings.length > 0 && (
                    <div className={styles.safetyBlock}>
                      <h3 className={styles.safetySubhead}>Why</h3>
                      <ul className={styles.safetyList}>
                        {safety.findings.map((finding) => (
                          <li key={finding.ruleId}>{finding.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className={styles.safetyBlock}>
                    <h3 className={styles.safetySubhead}>Always</h3>
                    <ul className={styles.safetyList}>
                      {safety.precautions.map((precaution) => (
                        <li key={precaution.id}>{precaution.message}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <Card>
                <div className={styles.sessionHead}>
                  <p className={styles.symptom}>{detail.session.symptom}</p>
                  <Badge
                    variant={
                      SESSION_STATUS_DISPLAY[detail.session.status].variant
                    }
                  >
                    {SESSION_STATUS_DISPLAY[detail.session.status].label}
                  </Badge>
                </div>

                <h3 className={styles.subhead}>Possible causes</h3>
                {detail.session.causes.length === 0 ? (
                  <p className={styles.hint}>
                    Nothing suspected yet. Add what you think might be causing
                    this, and what would prove or disprove it.
                  </p>
                ) : (
                  <div className={styles.causeList}>
                    {detail.session.causes.map((cause) => {
                      const status = CAUSE_STATUS_DISPLAY[cause.status];
                      const busy = busyCauseId === cause.id;
                      const linked = measurements.find(
                        (m) => m.id === cause.resolvingMeasurementId,
                      );
                      return (
                        <div key={cause.id} className={styles.cause}>
                          <div className={styles.causeHead}>
                            <span className={styles.causeStatement}>
                              {cause.statement}
                            </span>
                            <Badge variant={status.variant}>
                              {status.label}
                            </Badge>
                          </div>

                          {cause.recommendedNextTest && (
                            <p className={styles.nextTest}>
                              Next test: {cause.recommendedNextTest}
                            </p>
                          )}

                          {linked && (
                            <p className={styles.linked}>
                              Linked reading: {linked.value}
                              {linked.unit} · {linked.result ?? "not evaluated"}
                            </p>
                          )}

                          <div className={styles.causeActions}>
                            {measurements.length > 0 && (
                              <Select
                                aria-label="Link a reading to this cause"
                                value={cause.resolvingMeasurementId ?? ""}
                                disabled={busy}
                                onChange={(e) =>
                                  patchCause(
                                    cause.id,
                                    {
                                      resolvingMeasurementId:
                                        e.target.value || null,
                                    },
                                    e.target.value
                                      ? "Reading linked"
                                      : "Reading unlinked",
                                  )
                                }
                              >
                                <option value="">No linked reading</option>
                                {measurements.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.value}
                                    {m.unit} — {m.testType}
                                  </option>
                                ))}
                              </Select>
                            )}
                            {cause.status !== "confirmed" && (
                              <Button
                                type="button"
                                variant="secondary"
                                loading={busy}
                                onClick={() =>
                                  patchCause(
                                    cause.id,
                                    { status: "confirmed" },
                                    "Cause confirmed",
                                  )
                                }
                              >
                                Confirm
                              </Button>
                            )}
                            {cause.status !== "ruled_out" && (
                              <Button
                                type="button"
                                variant="secondary"
                                loading={busy}
                                onClick={() =>
                                  patchCause(
                                    cause.id,
                                    { status: "ruled_out" },
                                    "Cause ruled out",
                                  )
                                }
                              >
                                Rule out
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className={styles.advice}>
                  {/* Below the safety banner and the causes on purpose:
                      the deterministic verdict is what the technician
                      acts on, and the AI explains the situation around
                      it. The key changes whenever a reading, a cause
                      status or the verdict changes, which is what marks
                      earlier reasoning stale. */}
                  <DiagnosticAdvicePanel
                    orgId={orgId}
                    jobId={jobId}
                    sessionId={detail.session.id}
                    stateKey={[
                      safety?.state ?? "",
                      ...(safety?.firedRuleIds ?? []),
                      ...measurements.map(
                        (m) => `${m.id}:${m.value}:${m.result ?? "null"}`,
                      ),
                      ...detail.session.causes.map(
                        (c) => `${c.id}:${c.status}`,
                      ),
                    ].join("|")}
                  />
                </div>

                <div className={styles.addCause}>
                  <FormField label="Add a possible cause" htmlFor="d-cause">
                    <Input
                      id="d-cause"
                      value={causeStatement}
                      onChange={(e) => setCauseStatement(e.target.value)}
                      placeholder="e.g. Shorted conductor in the branch circuit"
                    />
                  </FormField>
                  <FormField label="What would settle it?" htmlFor="d-next">
                    <Input
                      id="d-next"
                      value={causeNextTest}
                      onChange={(e) => setCauseNextTest(e.target.value)}
                      placeholder="e.g. Insulation resistance test on that run"
                    />
                  </FormField>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleAddCause}
                    loading={addingCause}
                    loadingText="Adding..."
                    disabled={!causeStatement.trim()}
                  >
                    Add cause
                  </Button>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </section>
  );
}
