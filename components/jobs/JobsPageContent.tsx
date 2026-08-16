"use client";

import { useMemo, useState } from "react";
import {
  PageHeader,
  Button,
  Card,
  CardLink,
  StatusBadge,
  EmptyState,
  Input,
} from "@/components/ui";
import { CreateJobForm } from "@/components/CreateJobForm";
import { formatRelativeDate } from "@/lib/ui/formatRelativeDate";
import styles from "./JobsPageContent.module.css";

type JobStatus = "open" | "in_progress" | "completed";

type JobListItem = {
  id: string;
  title: string;
  status: JobStatus;
  problemDescription: string | null;
  updatedAt: Date | string;
  customer: { id: string; name: string };
};

type CustomerOption = { id: string; name: string };

const STATUS_FILTERS: { value: JobStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

// Active work surfaces first; completed jobs sink to the bottom.
const STATUS_PRIORITY: Record<JobStatus, number> = {
  open: 0,
  in_progress: 0,
  completed: 1,
};

export function JobsPageContent({
  orgId,
  jobs,
  customers,
  initialCustomerId,
}: {
  orgId: string;
  jobs: JobListItem[];
  customers: CustomerOption[];
  initialCustomerId?: string;
}) {
  const [showForm, setShowForm] = useState(Boolean(initialCustomerId));
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "all">("all");

  const visibleJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs
      .filter((job) => statusFilter === "all" || job.status === statusFilter)
      .filter((job) => {
        if (!normalizedQuery) return true;
        return (
          job.title.toLowerCase().includes(normalizedQuery) ||
          job.customer.name.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => {
        const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
        if (priorityDiff !== 0) return priorityDiff;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [jobs, query, statusFilter]);

  return (
    <div>
      <PageHeader
        title="Jobs"
        actions={
          <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "+ New Job"}
          </Button>
        }
      />

      {showForm && (
        <Card className={styles.formCard}>
          <div className={styles.formCardHeader}>
            <h2 className={styles.formCardTitle}>New job</h2>
          </div>
          <CreateJobForm
            orgId={orgId}
            customers={customers}
            initialCustomerId={initialCustomerId}
            onCreated={() => setShowForm(false)}
          />
        </Card>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          title="No jobs yet"
          description="Jobs are where you document a customer's problem, evidence, and the work you do to fix it. Create your first job to get started."
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <Input
              placeholder="Search jobs by title or customer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search jobs"
            />
            <div className={styles.filterRow} role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`${styles.filterChip} ${
                    statusFilter === filter.value ? styles.filterChipActive : ""
                  }`}
                  onClick={() => setStatusFilter(filter.value)}
                  aria-pressed={statusFilter === filter.value}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {visibleJobs.length === 0 ? (
            <EmptyState
              title="No jobs match your search"
              description="Try a different search term or clear the status filter."
            />
          ) : (
            <div>
              {visibleJobs.map((job) => (
                <CardLink key={job.id} href={`/orgs/${orgId}/jobs/${job.id}`}>
                  <div className={styles.jobCard}>
                    <div className={styles.jobCardTop}>
                      <div>
                        <p className={styles.jobTitle}>{job.title}</p>
                        <p className={styles.jobCustomer}>{job.customer.name}</p>
                      </div>
                      <StatusBadge status={job.status} />
                    </div>
                    {job.problemDescription && (
                      <p className={styles.jobDescription}>{job.problemDescription}</p>
                    )}
                    <p className={styles.jobMeta}>Updated {formatRelativeDate(job.updatedAt)}</p>
                  </div>
                </CardLink>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
