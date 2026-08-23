"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  Badge,
  Button,
  FormField,
  Input,
  EmptyState,
  ErrorState,
  ConfirmDialog,
  useToast,
} from "@/components/ui";
import styles from "./QuoteSection.module.css";

export type QuoteLineItem = {
  id: string;
  kind: "material" | "labor";
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

export type QuoteData = {
  id: string;
  subtotalCents: number;
  totalCents: number;
  lineItems: QuoteLineItem[];
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

/** Dollar-string input -> integer cents, or null if not a valid
 * non-negative amount. Same convention as MaterialsSection: the API only
 * ever deals in cents, so this conversion is entirely a UI concern. */
function parseDollarsToCents(input: string): number | null {
  const n = Number(input);
  if (input.trim() === "" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

type FormValues = { description: string; quantity: string; unitCost: string };

const EMPTY_FORM: FormValues = { description: "", quantity: "1", unitCost: "" };

function validate(values: FormValues): string | null {
  if (values.description.trim() === "") return "Enter a description.";
  const quantity = Number(values.quantity);
  if (values.quantity.trim() === "" || !Number.isFinite(quantity) || quantity <= 0) {
    return "Quantity must be a positive number.";
  }
  if (parseDollarsToCents(values.unitCost) === null) {
    return "Unit price must be a number, 0 or greater.";
  }
  return null;
}

/**
 * The job's one quote. Placed directly after MaterialsSection, matching
 * the workflow order: confirmed findings + materials -> quote. Manages
 * its own saves, like every other section on this page -- nothing here
 * depends on JobWorkspace's own "Save changes" submit.
 */
export function QuoteSection({
  orgId,
  jobId,
  quote: initialQuote,
}: {
  orgId: string;
  jobId: string;
  quote: QuoteData | null;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [quote, setQuote] = useState(initialQuote);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormValues>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<QuoteLineItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleGenerate() {
    setGenerateError(null);
    setGenerating(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/jobs/${jobId}/quote/generate`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error === "quote_already_exists"
            ? "A quote already exists for this job."
            : "Could not generate a quote. Try again.",
        );
      }
      const { quote: created } = await response.json();
      setQuote(created);
      showToast("Quote generated");
      router.refresh();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Could not generate a quote.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAddLabor(event: React.FormEvent) {
    event.preventDefault();
    const problem = validate(form);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/quote/line-items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: form.description.trim(),
            quantity: Number(form.quantity),
            unitPriceCents: parseDollarsToCents(form.unitCost),
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Could not add that labor line. Try again.");
      }
      const { quote: updated } = await response.json();
      setQuote(updated);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      showToast("Labor line added");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that labor line.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(item: QuoteLineItem) {
    setEditingId(item.id);
    setEditError(null);
    setEditForm({
      description: item.description,
      quantity: String(item.quantity),
      unitCost: (item.unitPriceCents / 100).toFixed(2),
    });
  }

  async function handleUpdate(lineItemId: string) {
    const problem = validate(editForm);
    if (problem) {
      setEditError(problem);
      return;
    }

    setEditError(null);
    setUpdating(true);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/quote/line-items/${lineItemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: editForm.description.trim(),
            quantity: Number(editForm.quantity),
            unitPriceCents: parseDollarsToCents(editForm.unitCost),
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Could not save that change. Try again.");
      }
      const { quote: updated } = await response.json();
      setQuote(updated);
      setEditingId(null);
      showToast("Line item updated");
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save that change.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/quote/line-items/${pendingDelete.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Could not delete that line item.");
      const { quote: updated } = await response.json();
      setQuote(updated);
      setPendingDelete(null);
      showToast("Line item deleted");
      router.refresh();
    } catch (err) {
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : "Could not delete that line item.");
    } finally {
      setDeleting(false);
    }
  }

  if (!quote) {
    return (
      <section className={styles.section}>
        <div className={styles.header}>
          <h2 className={styles.sectionTitle}>Quote</h2>
        </div>
        <Card>
          <EmptyState
            title="No quote yet"
            description="Generate a quote from this job's current materials and confirmed findings. Confirmed findings are added as zero-priced labor lines for you to price."
          />
          {generateError && (
            <ErrorState title="Could not generate a quote" description={generateError} />
          )}
          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleGenerate}
              loading={generating}
              loadingText="Generating..."
            >
              Generate quote
            </Button>
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Quote</h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError(null);
            setForm(EMPTY_FORM);
            setFormOpen((open) => !open);
          }}
        >
          {formOpen ? "Cancel" : "Add labor"}
        </Button>
      </div>

      {formOpen && (
        <Card>
          <div className={styles.formGrid}>
            <div className={styles.fullWidth}>
              <FormField label="Description" htmlFor="quote-labor-description" required>
                <Input
                  id="quote-labor-description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="e.g. Diagnose and repair kitchen circuit"
                />
              </FormField>
            </div>
            <FormField label="Quantity (hours)" htmlFor="quote-labor-quantity" required>
              <Input
                id="quote-labor-quantity"
                inputMode="decimal"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
              />
            </FormField>
            <FormField label="Unit price" htmlFor="quote-labor-unit-cost" required>
              <Input
                id="quote-labor-unit-cost"
                inputMode="decimal"
                value={form.unitCost}
                onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
                placeholder="0.00"
              />
            </FormField>
          </div>

          {error && (
            <ErrorState title="Could not add that labor line" description={error} />
          )}

          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleAddLabor}
              loading={saving}
              loadingText="Saving..."
            >
              Add labor line
            </Button>
          </div>
        </Card>
      )}

      {error && !formOpen && (
        <ErrorState title="Something went wrong" description={error} />
      )}

      {quote.lineItems.length === 0 ? (
        <EmptyState
          title="This quote has no line items"
          description="Add a labor line to get started."
        />
      ) : (
        <div className={styles.list}>
          {quote.lineItems.map((item) => {
            if (editingId === item.id) {
              return (
                <Card key={item.id} padding="sm">
                  <div className={styles.formGrid}>
                    <div className={styles.fullWidth}>
                      <FormField label="Description" htmlFor={`quote-edit-description-${item.id}`} required>
                        <Input
                          id={`quote-edit-description-${item.id}`}
                          value={editForm.description}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, description: e.target.value }))
                          }
                        />
                      </FormField>
                    </div>
                    <FormField label="Quantity" htmlFor={`quote-edit-quantity-${item.id}`} required>
                      <Input
                        id={`quote-edit-quantity-${item.id}`}
                        inputMode="decimal"
                        value={editForm.quantity}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, quantity: e.target.value }))
                        }
                      />
                    </FormField>
                    <FormField label="Unit price" htmlFor={`quote-edit-unit-cost-${item.id}`} required>
                      <Input
                        id={`quote-edit-unit-cost-${item.id}`}
                        inputMode="decimal"
                        value={editForm.unitCost}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, unitCost: e.target.value }))
                        }
                      />
                    </FormField>
                  </div>

                  {editError && (
                    <ErrorState title="Could not save that change" description={editError} />
                  )}

                  <div className={styles.actions}>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setEditingId(null)}
                      disabled={updating}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => handleUpdate(item.id)}
                      loading={updating}
                      loadingText="Saving..."
                    >
                      Save
                    </Button>
                  </div>
                </Card>
              );
            }

            return (
              <Card key={item.id} padding="sm">
                <div className={styles.row}>
                  <div className={styles.details}>
                    <div className={styles.descriptionRow}>
                      <Badge variant={item.kind === "material" ? "neutral" : "success"}>
                        {item.kind === "material" ? "Material" : "Labor"}
                      </Badge>
                      <span className={styles.description}>{item.description}</span>
                    </div>
                    <span className={styles.lineMeta}>
                      {item.quantity} x {formatCents(item.unitPriceCents)}
                    </span>
                  </div>
                  <div className={styles.rowActions}>
                    <span className={styles.lineTotal}>{formatCents(item.lineTotalCents)}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(item)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete(item)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div className={styles.totals}>
        <div className={styles.totalsRow}>
          <span>Subtotal</span>
          <span>{formatCents(quote.subtotalCents)}</span>
        </div>
        <div className={styles.totalsRowFinal}>
          <span>Total</span>
          <span>{formatCents(quote.totalCents)}</span>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this line item?"
        description={pendingDelete ? `"${pendingDelete.description}" will be removed from this quote.` : undefined}
        confirmLabel="Delete line item"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
