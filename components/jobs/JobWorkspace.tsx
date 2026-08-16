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
  ErrorState,
  useToast,
} from "@/components/ui";
import { EvidenceSection, type EvidenceItem } from "./EvidenceSection";
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
}: {
  orgId: string;
  job: Job;
  evidence: EvidenceItem[];
  evidenceLimit: number;
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
          nextStatus && (
            <Button
              variant="primary"
              onClick={handleAdvanceStatus}
              loading={advancingStatus}
              loadingText="Updating..."
            >
              {nextStatus.label}
            </Button>
          )
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
            immediately rather than waiting on "Save changes". A future AI
            Assessment section would slot in right after it. */}
        <EvidenceSection
          orgId={orgId}
          jobId={job.id}
          evidence={evidence}
          limit={evidenceLimit}
        />

        {/* Job details: administrative fields. A future Materials/Quote
            section would slot in after this, before a closing Timeline. */}
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
