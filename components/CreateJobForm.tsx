"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, Input, Select, Textarea, Button, ErrorState } from "@/components/ui";
import formStyles from "./forms.module.css";

type CustomerOption = { id: string; name: string };

export function CreateJobForm({
  orgId,
  customers,
  initialCustomerId,
  onCreated,
}: {
  orgId: string;
  customers: CustomerOption[];
  initialCustomerId?: string;
  onCreated?: () => void;
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
      onCreated?.();
      router.push(`/orgs/${orgId}/jobs/${job.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (customers.length === 0) {
    return (
      <p>
        Add a customer first, then come back here to create a job for them.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormField label="Customer" htmlFor="job-customer" required>
        <Select
          id="job-customer"
          required
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Job title" htmlFor="job-title" required>
        <Input
          id="job-title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="No power to kitchen outlets"
        />
      </FormField>
      <FormField
        label="Problem description"
        htmlFor="job-description"
        hint="What the customer told you, in their words."
      >
        <Textarea
          id="job-description"
          value={problemDescription}
          onChange={(e) => setProblemDescription(e.target.value)}
        />
      </FormField>
      {error && <ErrorState title="Could not create job" description={error} />}
      <div className={formStyles.actions}>
        <Button type="submit" variant="primary" loading={submitting} loadingText="Creating...">
          Create job
        </Button>
      </div>
    </form>
  );
}
