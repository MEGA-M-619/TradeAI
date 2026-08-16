"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  FormField,
  Input,
  Textarea,
  Button,
  ErrorState,
  ConfirmDialog,
  useToast,
} from "@/components/ui";
import formStyles from "./forms.module.css";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
};

export function CustomerDetailForm({
  orgId,
  customer,
}: {
  orgId: string;
  customer: Customer;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [address, setAddress] = useState(customer.address ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/customers/${customer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, email, address, notes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Could not save changes.");
        return;
      }
      showToast("Changes saved");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/orgs/${orgId}/customers/${customer.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setConfirmingDelete(false);
        setError(
          body?.error === "internal_error"
            ? "Could not delete -- this customer likely still has jobs on record."
            : (body?.error ?? "Could not delete customer."),
        );
        return;
      }
      showToast("Customer deleted");
      router.push(`/orgs/${orgId}/customers`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSave}>
        <FormField label="Name" htmlFor="edit-name" required>
          <Input id="edit-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="Phone" htmlFor="edit-phone">
          <Input
            id="edit-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </FormField>
        <FormField label="Email" htmlFor="edit-email">
          <Input
            id="edit-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </FormField>
        <FormField label="Address" htmlFor="edit-address">
          <Input id="edit-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </FormField>
        <FormField label="Notes" htmlFor="edit-notes">
          <Textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        {error && <ErrorState title="Could not save changes" description={error} />}
        <div className={formStyles.actions}>
          <Button type="submit" variant="primary" loading={submitting} loadingText="Saving...">
            Save changes
          </Button>
        </div>
      </form>

      <div className={formStyles.dangerZone}>
        <Button type="button" variant="danger" onClick={() => setConfirmingDelete(true)}>
          Delete customer
        </Button>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete ${customer.name}?`}
        description="This cannot be undone. Customers with existing jobs can't be deleted."
        confirmLabel="Delete customer"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}
