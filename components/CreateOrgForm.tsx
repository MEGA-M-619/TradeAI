"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, Input, Button, ErrorState } from "@/components/ui";
import formStyles from "./forms.module.css";

export function CreateOrgForm({ submitLabel = "Create organization" }: { submitLabel?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Could not create organization.");
        return;
      }
      const { organization } = await response.json();
      setName("");
      router.push(`/orgs/${organization.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormField
        label="Business name"
        htmlFor="org-name"
        required
        hint="Your company or trade name -- this is what your customers and quotes will show."
      >
        <Input
          id="org-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Electric"
        />
      </FormField>
      {error && <ErrorState title="Could not create organization" description={error} />}
      <div className={formStyles.actions}>
        <Button type="submit" variant="primary" fullWidth loading={submitting} loadingText="Creating...">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
