"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type CustomerOption = { id: string; name: string };

export function CreateJobForm({
  orgId,
  customers,
  initialCustomerId,
}: {
  orgId: string;
  customers: CustomerOption[];
  initialCustomerId?: string;
}) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(
    initialCustomerId ?? customers[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [problemDescription, setProblemDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, title, problemDescription }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Could not create job.");
        return;
      }
      const { job } = await response.json();
      router.push(`/orgs/${orgId}/jobs/${job.id}`);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (customers.length === 0) {
    return <p>Add a customer first before creating a job.</p>;
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Customer
        <select
          required
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="No power to kitchen outlets"
        />
      </label>
      <label>
        Problem description
        <textarea
          value={problemDescription}
          onChange={(e) => setProblemDescription(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating..." : "Create job"}
      </button>
    </form>
  );
}
