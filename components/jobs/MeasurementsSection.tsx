"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  Badge,
  type BadgeVariant,
  FormField,
  Input,
  Select,
  Button,
  EmptyState,
  ErrorState,
  useToast,
} from "@/components/ui";
import styles from "./MeasurementsSection.module.css";

export type MeasurementResultValue =
  | "pass"
  | "fail"
  | "inconclusive"
  | "not_applicable"
  | null;

export type MeasurementItem = {
  id: string;
  testType: string;
  circuitId: string | null;
  value: number;
  unit: string;
  expectedMin: number | null;
  expectedMax: number | null;
  result: MeasurementResultValue;
  note: string | null;
  recordedAt: string;
};

export type CircuitOption = {
  id: string;
  label: string;
  panelLabel: string | null;
};

/**
 * How an evaluated reading reads at a glance. The result itself is
 * computed server-side by lib/diagnostics/measurementRules.ts during
 * creation -- this maps it to a badge and nothing more. No evaluation
 * logic lives in the browser.
 *
 * Note `pass` is deliberately labelled "In range", not "OK" or "Safe":
 * it means the reading fell inside the range the technician themselves
 * supplied, which is a statement about that range, not about the
 * installation.
 */
const RESULT_DISPLAY: Record<
  NonNullable<MeasurementResultValue> | "unevaluated",
  { label: string; variant: BadgeVariant }
> = {
  pass: { label: "In range", variant: "success" },
  fail: { label: "Out of range", variant: "danger" },
  inconclusive: { label: "Inconclusive", variant: "warning" },
  not_applicable: { label: "No range given", variant: "neutral" },
  unevaluated: { label: "Not evaluated", variant: "neutral" },
};

const TEST_TYPE_LABELS: Record<string, string> = {
  voltage_ac: "Voltage (AC)",
  voltage_dc: "Voltage (DC)",
  continuity: "Continuity",
  resistance: "Resistance",
  current_ac: "Current (AC)",
  current_dc: "Current (DC)",
  insulation_resistance: "Insulation resistance",
  ground_impedance: "Ground impedance",
};

function labelForTestType(testType: string): string {
  return TEST_TYPE_LABELS[testType] ?? testType;
}

export function MeasurementsSection({
  orgId,
  jobId,
  customerId,
  measurements: initialMeasurements,
  circuits: initialCircuits,
  testTypes,
  allowedUnits,
}: {
  orgId: string;
  jobId: string;
  customerId: string;
  measurements: MeasurementItem[];
  circuits: CircuitOption[];
  testTypes: readonly string[];
  /** Closed unit vocabulary per test type, from
   * lib/validation/measurement.ts. Passed in from the server component so
   * the browser never re-derives which units are legal. */
  allowedUnits: Record<string, readonly string[]>;
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [measurements, setMeasurements] = useState(initialMeasurements);
  const [circuits, setCircuits] = useState(initialCircuits);

  const [formOpen, setFormOpen] = useState(false);
  const [testType, setTestType] = useState(testTypes[0] ?? "voltage_ac");
  const [unit, setUnit] = useState(allowedUnits[testTypes[0] ?? ""]?.[0] ?? "");
  const [value, setValue] = useState("");
  const [expectedMin, setExpectedMin] = useState("");
  const [expectedMax, setExpectedMax] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The working circuit. Every reading recorded from here is attributed
  // to it, which is what lets the safety layer identify a single circuit
  // under investigation for the session (it derives that from the
  // circuits a job's measurements reference). Defaults to the circuit the
  // last reading used, so a technician working one circuit does not have
  // to re-pick it each time.
  const [circuitId, setCircuitId] = useState<string>(
    initialMeasurements.findLast?.((m) => m.circuitId)?.circuitId ??
      initialCircuits[0]?.id ??
      "",
  );

  const [newCircuitLabel, setNewCircuitLabel] = useState("");
  const [creatingCircuit, setCreatingCircuit] = useState(false);

  const unitOptions = useMemo(
    () => allowedUnits[testType] ?? [],
    [allowedUnits, testType],
  );

  function handleTestTypeChange(next: string) {
    setTestType(next);
    // Keep the unit legal for the newly chosen test type rather than
    // letting the server reject the combination.
    const units = allowedUnits[next] ?? [];
    if (!units.includes(unit)) setUnit(units[0] ?? "");
  }

  function resetForm() {
    setValue("");
    setExpectedMin("");
    setExpectedMax("");
    setNote("");
    setError(null);
  }

  async function handleCreateCircuit() {
    const label = newCircuitLabel.trim();
    if (!label) return;
    setCreatingCircuit(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/customers/${customerId}/circuits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        },
      );
      if (!response.ok) {
        throw new Error("Could not add that circuit. Check the name and retry.");
      }
      const { circuit } = await response.json();
      setCircuits((current) => [
        ...current,
        { id: circuit.id, label: circuit.label, panelLabel: circuit.panelLabel },
      ]);
      setCircuitId(circuit.id);
      setNewCircuitLabel("");
      showToast(`Circuit "${circuit.label}" added`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add circuit.");
    } finally {
      setCreatingCircuit(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsedValue = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsedValue)) {
      setError("Enter the reading as a number.");
      return;
    }
    const min = expectedMin.trim() === "" ? undefined : Number(expectedMin);
    const max = expectedMax.trim() === "" ? undefined : Number(expectedMax);
    if (min !== undefined && !Number.isFinite(min)) {
      setError("Expected minimum must be a number, or left blank.");
      return;
    }
    if (max !== undefined && !Number.isFinite(max)) {
      setError("Expected maximum must be a number, or left blank.");
      return;
    }
    if (min !== undefined && max !== undefined && min > max) {
      setError("Expected minimum cannot be greater than the maximum.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/jobs/${jobId}/measurements`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            testType,
            value: parsedValue,
            unit,
            circuitId: circuitId || undefined,
            expectedMin: min,
            expectedMax: max,
            note: note.trim() || undefined,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.error === "not_found") {
          throw new Error(
            body.field === "circuit"
              ? "That circuit no longer belongs to this job's customer."
              : "This job could not be found. Reload and try again.",
          );
        }
        if (body?.error === "invalid_input") {
          throw new Error(
            `That reading was rejected: ${unit} is not a valid unit for ${labelForTestType(testType)}.`,
          );
        }
        throw new Error("Could not save that reading. Try again.");
      }

      const { measurement } = await response.json();
      setMeasurements((current) => [...current, measurement]);
      resetForm();
      showToast("Reading recorded");
      // The safety verdict is derived from these readings, so the
      // diagnostics section must re-render against the new fact set.
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save that reading.",
      );
    } finally {
      setSaving(false);
    }
  }

  const circuitName = (id: string | null) =>
    id ? (circuits.find((c) => c.id === id)?.label ?? "Unknown circuit") : null;

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Measurements</h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            resetForm();
            setFormOpen((open) => !open);
          }}
        >
          {formOpen ? "Cancel" : "Record reading"}
        </Button>
      </div>

      {formOpen && (
        <Card>
          <div className={styles.formGrid}>
            <FormField label="Test type" htmlFor="m-test-type" required>
              <Select
                id="m-test-type"
                value={testType}
                onChange={(e) => handleTestTypeChange(e.target.value)}
              >
                {testTypes.map((type) => (
                  <option key={type} value={type}>
                    {labelForTestType(type)}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="Unit" htmlFor="m-unit" required>
              <Select
                id="m-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                {unitOptions.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="Reading" htmlFor="m-value" required>
              <Input
                id="m-value"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. 230"
              />
            </FormField>

            <FormField
              label="Circuit"
              htmlFor="m-circuit"
              hint="Attributing readings to a circuit is what lets the safety check identify what is being worked on."
            >
              <Select
                id="m-circuit"
                value={circuitId}
                onChange={(e) => setCircuitId(e.target.value)}
              >
                <option value="">Not attributed</option>
                {circuits.map((circuit) => (
                  <option key={circuit.id} value={circuit.id}>
                    {circuit.panelLabel
                      ? `${circuit.label} (${circuit.panelLabel})`
                      : circuit.label}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="Expected minimum"
              htmlFor="m-expected-min"
              hint="Optional. Your own expected range — not a code limit."
            >
              <Input
                id="m-expected-min"
                inputMode="decimal"
                value={expectedMin}
                onChange={(e) => setExpectedMin(e.target.value)}
              />
            </FormField>

            <FormField label="Expected maximum" htmlFor="m-expected-max">
              <Input
                id="m-expected-max"
                inputMode="decimal"
                value={expectedMax}
                onChange={(e) => setExpectedMax(e.target.value)}
              />
            </FormField>

            <div className={styles.fullWidth}>
              <FormField label="Note" htmlFor="m-note">
                <Input
                  id="m-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Where or how this was taken"
                />
              </FormField>
            </div>
          </div>

          <div className={styles.newCircuitRow}>
            <FormField label="Add a circuit" htmlFor="m-new-circuit">
              <Input
                id="m-new-circuit"
                value={newCircuitLabel}
                onChange={(e) => setNewCircuitLabel(e.target.value)}
                placeholder="e.g. Kitchen ring"
              />
            </FormField>
            <Button
              type="button"
              variant="secondary"
              onClick={handleCreateCircuit}
              loading={creatingCircuit}
              loadingText="Adding..."
              disabled={!newCircuitLabel.trim()}
            >
              Add circuit
            </Button>
          </div>

          {error && (
            <ErrorState title="Could not record that reading" description={error} />
          )}

          <div className={styles.actions}>
            <Button
              type="button"
              variant="primary"
              onClick={handleSubmit}
              loading={saving}
              loadingText="Saving..."
            >
              Save reading
            </Button>
          </div>
        </Card>
      )}

      {measurements.length === 0 ? (
        <EmptyState
          title="No readings yet"
          description="Record what you measure so the diagnostic and safety checks have something to work from."
        />
      ) : (
        <div className={styles.list}>
          {measurements.map((measurement) => {
            const display =
              RESULT_DISPLAY[measurement.result ?? "unevaluated"];
            const circuit = circuitName(measurement.circuitId);
            return (
              <Card key={measurement.id} padding="sm">
                <div className={styles.row}>
                  <div className={styles.reading}>
                    <span className={styles.value}>
                      {measurement.value}
                      <span className={styles.unit}>{measurement.unit}</span>
                    </span>
                    <span className={styles.testType}>
                      {labelForTestType(measurement.testType)}
                    </span>
                  </div>
                  <div className={styles.meta}>
                    <Badge variant={display.variant}>{display.label}</Badge>
                    {circuit ? (
                      <span className={styles.circuit}>{circuit}</span>
                    ) : (
                      <span className={styles.unattributed}>
                        No circuit attributed
                      </span>
                    )}
                  </div>
                </div>
                {(measurement.expectedMin !== null ||
                  measurement.expectedMax !== null) && (
                  <p className={styles.expected}>
                    Expected {measurement.expectedMin ?? "any"} to{" "}
                    {measurement.expectedMax ?? "any"} {measurement.unit}
                    <span className={styles.criterion}>
                      {" "}
                      · range supplied by technician, not a verified standard
                    </span>
                  </p>
                )}
                {measurement.note && (
                  <p className={styles.note}>{measurement.note}</p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
