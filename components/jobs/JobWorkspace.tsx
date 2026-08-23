"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  PageHeader,
  Card,
  StatusBadge,
  FormField,
  Input,
  Textarea,
  Select,
  Button,
  LinkButton,
  ErrorState,
  useToast,
} from "@/components/ui";
import { EvidenceSection, type EvidenceItem } from "./EvidenceSection";
import { AssessmentSection, type AssessmentSummary } from "./AssessmentSection";
import {
  MeasurementsSection,
  type MeasurementItem,
  type CircuitOption,
} from "./MeasurementsSection";
import {
  DiagnosticsSection,
  type DiagnosticSessionSummary,
} from "./DiagnosticsSection";
import { MaterialsSection, type MaterialItem } from "./MaterialsSection";
import { QuoteSection, type QuoteData } from "./QuoteSection";
import styles from "./JobWorkspace.module.css";

type JobStatus = "open" | "in_progress" | "completed";

type Job = {
  id: string;
  title: string;
  problemDescription: string | null;
  status: JobStatus;
  customer: { id: string; name: string };
};

const NEXT_STATUS: Partial<Record<JobStatus, { status: JobStatus; label: string }>> = {
  open: { status: "in_progress", label: "Start Job" },
  in_progress: { status: "completed", label: "Mark Complete" },
};

export function JobWorkspace({
  orgId,
  job,
  evidence,
  evidenceLimit,
  assessments,
  maxAssessmentImages,
  measurements,
  circuits,
  diagnosticSessions,
  measurementTestTypes,
  allowedUnits,
  materials,
  quote,
}: {
  orgId: string;
  job: Job;
  evidence: EvidenceItem[];
  evidenceLimit: number;
  assessments: AssessmentSummary[];
  maxAssessmentImages: number;
  measurements: MeasurementItem[];
  circuits: CircuitOption[];
  diagnosticSessions: DiagnosticSessionSummary[];
  measurementTestTypes: readonly string[];
  allowedUnits: Record<string, readonly string[]>;
  materials: MaterialItem[];
  quote: QuoteData | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [title, setTitle] = useState(job.title);
  const [problemDescription, setProblemDescription] = useState(job.problemDescription ?? "");
  const [status, setStatus] = useState<JobStatus>(job.status);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancingStatus, setAdvancingStatus] = useState(false);

  async function patchJob(data: Partial<{ title: string; problemDescription: string; status: JobStatus }>) {
    const response = await fetch(`/api/orgs/${orgId}/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error ?? "Could not save changes.");
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await patchJob({ title, problemDescription, status });
      showToast("Changes saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  }

  const nextStatus = NEXT_STATUS[status];

  async function handleAdvanceStatus() {
    if (!nextStatus) return;
    setAdvancingStatus(true);
    setError(null);
    try {
      await patchJob({ status: nextStatus.status });
      setStatus(nextStatus.status);
      showToast(
        nextStatus.status === "completed" ? "Job marked complete" : "Job started",
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update status.");
    } finally {
      setAdvancingStatus(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={title}
        backHref={`/orgs/${orgId}/jobs`}
        backLabel="Jobs"
        meta={<StatusBadge status={status} />}
        actions={
          <>
            <LinkButton href={`/orgs/${orgId}/jobs/${job.id}/report`} variant="secondary">
              View report
            </LinkButton>
            {nextStatus && (
              <Button
                variant="primary"
                onClick={handleAdvanceStatus}
                loading={advancingStatus}
                loadingText="Updating..."
              >
                {nextStatus.label}
              </Button>
            )}
          </>
        }
      />

      <p className={styles.customerLine}>
        Customer: <Link href={`/orgs/${orgId}/customers/${job.customer.id}`}>{job.customer.name}</Link>
      </p>

      {error && (
        <div className={styles.section}>
          <ErrorState title="Something went wrong" description={error} />
        </div>
      )}

      <form onSubmit={handleSave}>
        {/* Problem: what the customer reported, in their words. */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Problem</h2>
          <Card>
            <FormField label="Customer's reported problem" htmlFor="job-problem">
              <Textarea
                id="job-problem"
                value={problemDescription}
                onChange={(e) => setProblemDescription(e.target.value)}
                placeholder="What did the customer say is wrong?"
              />
            </FormField>
          </Card>
        </section>

        {/* Evidence sits directly after the reported problem: it is what
            turns a customer's account into something observed. It manages
            its own uploads and is not part of this form's save -- every
            control inside it is type="button" -- so photos persist
            immediately rather than waiting on "Save changes". */}
        <EvidenceSection
          orgId={orgId}
          jobId={job.id}
          evidence={evidence}
          limit={evidenceLimit}
        />

        {/* Measurements: what was actually read on site. Each reading is
            evaluated server-side on creation, and attributing readings to
            a circuit is what lets the safety layer below identify the
            circuit under investigation. Manages its own saves. */}
        <MeasurementsSection
          orgId={orgId}
          jobId={job.id}
          customerId={job.customer.id}
          measurements={measurements}
          circuits={circuits}
          testTypes={measurementTestTypes}
          allowedUnits={allowedUnits}
        />

        {/* Diagnosis and safety. Placed directly after the readings it
            reasons over, and before the AI assessment, because the
            deterministic safety verdict is the thing that should be read
            first -- not something found after scrolling past model
            output. */}
        <DiagnosticsSection
          orgId={orgId}
          jobId={job.id}
          sessions={diagnosticSessions}
          measurements={measurements}
        />

        {/* AI Assessment: reviews the technician's chosen evidence and
            proposes observations/hypotheses for the technician to confirm
            or reject. Also manages its own requests/polling independently
            of this form's save. */}
        <AssessmentSection
          orgId={orgId}
          jobId={job.id}
          evidence={evidence}
          initialAssessments={assessments}
          maxImages={maxAssessmentImages}
        />

        {/* Materials: manual-entry line items, placed directly after the
            AI assessment/technician-review step it follows in the
            workflow -- confirmed findings inform what materials the job
            needs. Manages its own saves, same as the sections above. */}
        <MaterialsSection orgId={orgId} jobId={job.id} materials={materials} />

        {/* Quote: generated from this job's confirmed findings and
            materials, then priced/edited manually. Placed last in the
            workflow chain -- everything above it (findings, materials) is
            an input a quote is generated from. A future Report section
            would slot in after this one. */}
        <QuoteSection orgId={orgId} jobId={job.id} quote={quote} />

        {/* Job details: administrative fields. */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Job details</h2>
          <Card>
            <FormField label="Job title" htmlFor="job-title" required>
              <Input
                id="job-title"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <FormField label="Status" htmlFor="job-status">
              <Select
                id="job-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as JobStatus)}
              >
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </Select>
            </FormField>
          </Card>
        </section>

        <div className={styles.saveRow}>
          <Button type="submit" variant="primary" loading={saving} loadingText="Saving...">
            Save changes
          </Button>
        </div>
      </form>
    </div>
  );
}
