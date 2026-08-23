"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  Button,
  FormField,
  Input,
  EmptyState,
  ErrorState,
  ConfirmDialog,
  useToast,
} from "@/components/ui";
import styles from "./MaterialsSection.module.css";

export type MaterialItem = {
  id: string;
  description: string;
  quantity: number;
  unitCostCents: number;
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

/** Dollar-string input -> integer cents, or null if not a valid non-negative
 * amount. The API/storage boundary only ever deals in cents (see
 * lib/validation/material.ts); the dollar<->cents conversion is entirely
 * this component's concern. */
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
    return "Unit cost must be a number, 0 or greater.";
  }
  return null;
}

/**
 * Manual-entry job material line items. Placed after AssessmentSection and
 * before Job details, matching the workflow order: confirmed findings ->
 * materials. Manages its own saves, like EvidenceSection and
 * MeasurementsSection -- every control here is type="button", so nothing
 * here depends on JobWorkspace's own "Save changes" submit.
 */
export function MaterialsSection({
  orgId,
  jobId,
  materials: initialMaterials,
}: {
  orgId: string;
  jobId: string;
  materials: MaterialItem[];
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [materials, setMaterials] = useState(initialMaterials);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormValues>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<MaterialItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const total = materials.reduce(
    (sum, m) => sum + m.quantity * m.unitCostCents,
    0,
  );

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const problem = validate(form);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const response = await fetch(`/api/orgs/${orgId}/jobs/${jobId}/materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: form.description.trim(),
          quantity: Number(form.quantity),
          unitCostCents: parseDollarsToCents(form.unitCost),
        }),
      });
      if (!response.ok) {
        throw new Error("Could not save that material. Try again.");
      }
      const { material } = await response.json();
      setMaterials((current) => [...current, material]);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      showToast("Material added");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that material.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(material: MaterialItem) {
    setEditingId(material.id);
    setEditError(null);
    setEditForm({
      description: material.description,
      quantity: String(material.quantity),
      unitCost: (material.unitCostCents / 100).toFixed(2),
    });
  }

  async function handleUpdate(materialId: string) {
    const problem = validate(editForm);
    if (problem) {
      setEditError(problem);
      return;
    }

    setEditError(null);
    setUpdating(true);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/materials/${materialId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: editForm.description.trim(),
            quantity: Number(editForm.quantity),
            unitCostCents: parseDollarsToCents(editForm.unitCost),
          }),
        },
      );
      if (!response.ok) {
        throw new Error("Could not save that change. Try again.");
      }
      const { material } = await response.json();
      setMaterials((current) =>
        current.map((m) => (m.id === materialId ? material : m)),
      );
      setEditingId(null);
      showToast("Material updated");
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
        `/api/orgs/${orgId}/jobs/${jobId}/materials/${pendingDelete.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Could not delete that material.");
      setMaterials((current) => current.filter((m) => m.id !== pendingDelete.id));
      setPendingDelete(null);
      showToast("Material deleted");
      router.refresh();
    } catch (err) {
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : "Could not delete that material.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Materials</h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setError(null);
            setForm(EMPTY_FORM);
            setFormOpen((open) => !open);
          }}
        >
          {formOpen ? "Cancel" : "Add material"}
        </Button>
      </div>

      {formOpen && (
        <Card>
          <div className={styles.formGrid}>
            <div className={styles.fullWidth}>
              <FormField label="Description" htmlFor="mat-description" required>
                <Input
                  id="mat-description"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="e.g. 20A single-pole breaker"
                />
              </FormField>
            </div>
            <FormField label="Quantity" htmlFor="mat-quantity" required>
              <Input
                id="mat-quantity"
                inputMode="decimal"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
              />
            </FormField>
            <FormField label="Unit cost" htmlFor="mat-unit-cost" required>
              <Input
                id="mat-unit-cost"
                inputMode="decimal"
                value={form.unitCost}
                onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
                placeholder="0.00"
              />
            </FormField>
          </div>

          {error && (
            <ErrorState title="Could not save that material" description={error} />
          )}

          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleCreate}
              loading={saving}
              loadingText="Saving..."
            >
              Save material
            </Button>
          </div>
        </Card>
      )}

      {materials.length === 0 ? (
        <EmptyState
          title="No materials yet"
          description="Add the parts used on this job, with quantity and unit cost."
        />
      ) : (
        <div className={styles.list}>
          {materials.map((material) => {
            if (editingId === material.id) {
              return (
                <Card key={material.id} padding="sm">
                  <div className={styles.formGrid}>
                    <div className={styles.fullWidth}>
                      <FormField label="Description" htmlFor={`mat-edit-description-${material.id}`} required>
                        <Input
                          id={`mat-edit-description-${material.id}`}
                          value={editForm.description}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, description: e.target.value }))
                          }
                        />
                      </FormField>
                    </div>
                    <FormField label="Quantity" htmlFor={`mat-edit-quantity-${material.id}`} required>
                      <Input
                        id={`mat-edit-quantity-${material.id}`}
                        inputMode="decimal"
                        value={editForm.quantity}
                        onChange={(e) =>
                          setEditForm((f) => ({ ...f, quantity: e.target.value }))
                        }
                      />
                    </FormField>
                    <FormField label="Unit cost" htmlFor={`mat-edit-unit-cost-${material.id}`} required>
                      <Input
                        id={`mat-edit-unit-cost-${material.id}`}
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
                      onClick={() => handleUpdate(material.id)}
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
              <Card key={material.id} padding="sm">
                <div className={styles.row}>
                  <div className={styles.details}>
                    <span className={styles.description}>{material.description}</span>
                    <span className={styles.lineMeta}>
                      {material.quantity} x {formatCents(material.unitCostCents)}
                    </span>
                  </div>
                  <div className={styles.rowActions}>
                    <span className={styles.lineTotal}>
                      {formatCents(material.quantity * material.unitCostCents)}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(material)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete(material)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}

          <div className={styles.totalRow}>
            <span>Materials total</span>
            <span className={styles.totalValue}>{formatCents(total)}</span>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this material?"
        description={pendingDelete ? `"${pendingDelete.description}" will be removed from this job.` : undefined}
        confirmLabel="Delete material"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
