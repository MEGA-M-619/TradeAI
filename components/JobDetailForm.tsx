"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Job = {
  id: string;
  title: string;
  problemDescription: string | null;
  status: "open" | "in_progress" | "completed";
};

export function JobDetailForm({ orgId, job }: { orgId: string; job: Job }) {
  const router = useRouter();
  const [title, setTitle] = useState(job.title);
  const [problemDescription, setProblemDescription] = useState(
    job.problemDescription ?? "",
  );
  const [status, setStatus] = useState(job.status);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, problemDescription, status }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Could not save changes.");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSave}>
      <label>
        Title
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Problem description
        <textarea
          value={problemDescription}
          onChange={(e) => setProblemDescription(e.target.value)}
        />
      </label>
      <label>
        Status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Job["status"])}
        >
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving..." : "Save changes"}
      </button>
    </form>
  );
}
