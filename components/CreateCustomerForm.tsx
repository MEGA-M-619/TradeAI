"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormField, Input, Button, ErrorState } from "@/components/ui";
import formStyles from "./forms.module.css";

export function CreateCustomerForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, email }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Could not create customer.");
        return;
      }
      setName("");
      setPhone("");
      setEmail("");
      onCreated?.();
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <FormField label="Name" htmlFor="customer-name" required>
        <Input
          id="customer-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>
      <FormField label="Phone" htmlFor="customer-phone">
        <Input
          id="customer-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </FormField>
      <FormField label="Email" htmlFor="customer-email">
        <Input
          id="customer-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </FormField>
      {error && <ErrorState title="Could not add customer" description={error} />}
      <div className={formStyles.actions}>
        <Button type="submit" variant="primary" loading={submitting} loadingText="Adding...">
          Add customer
        </Button>
      </div>
    </form>
  );
}
