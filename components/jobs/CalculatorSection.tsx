"use client";

import { useMemo, useState } from "react";
import { Card, Button, FormField, Input, ErrorState } from "@/components/ui";
import {
  explainFailure,
  formatQuantity,
  QUANTITY_LABELS,
  QUANTITY_UNITS,
  solve,
  type ElectricalQuantity,
  type KnownQuantities,
} from "@/lib/calculations/electrical";
import styles from "./CalculatorSection.module.css";

/**
 * A scratch Ohm's-law / power calculator for use at the panel.
 *
 * Deliberately NOT persisted. A derived value is not a measurement: only a
 * reading actually taken off an instrument belongs in the Measurements
 * table, where it carries a test type, an expected range, and a computed
 * pass/fail. Writing a calculated number into that table would blur the one
 * distinction the report depends on -- what was measured versus what was
 * inferred -- so this component keeps its state local and writes nothing.
 *
 * All arithmetic is delegated to lib/calculations/electrical.ts. No formula
 * is reimplemented here, and no model is consulted: the numbers a
 * technician may act on come from tested, deterministic code.
 */

const QUANTITY_ORDER: ElectricalQuantity[] = [
  "voltage",
  "current",
  "resistance",
  "power",
];

/** Free text -> number, preserving "the field is empty" as distinct from 0. */
function parseField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function CalculatorSection() {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<ElectricalQuantity, string>>({
    voltage: "",
    current: "",
    resistance: "",
    power: "",
  });

  const known: KnownQuantities = useMemo(() => {
    const next: KnownQuantities = {};
    for (const quantity of QUANTITY_ORDER) {
      const parsed = parseField(fields[quantity]);
      if (parsed !== undefined) next[quantity] = parsed;
    }
    return next;
  }, [fields]);

  // Solve for every quantity the technician has left blank. Showing all
  // derivable results at once matches how the tool is actually used --
  // enter what you measured, see what follows -- and avoids a "calculate"
  // round trip while standing at an open panel.
  const results = useMemo(
    () =>
      QUANTITY_ORDER.filter((q) => known[q] === undefined).map((quantity) => ({
        quantity,
        outcome: solve(quantity, known),
      })),
    [known],
  );

  const suppliedCount = Object.keys(known).length;
  const solved = results.filter((r) => r.outcome.ok);

  // Only worth surfacing a refusal once the technician has actually
  // committed to two inputs; before that, "enter two values" is noise.
  const blockingFailure = useMemo(() => {
    if (suppliedCount < 2) return null;
    for (const { outcome } of results) {
      if (!outcome.ok && outcome.reason !== "insufficient_inputs") {
        return outcome.reason;
      }
    }
    return null;
  }, [results, suppliedCount]);

  function reset() {
    setFields({ voltage: "", current: "", resistance: "", power: "" });
  }

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Calculator</h2>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Close" : "Open calculator"}
        </Button>
      </div>

      {open && (
        <Card>
          <p className={styles.intro}>
            Enter any two values to derive the others. Results are calculated
            by the app, not estimated by AI, and are not saved to the job.
          </p>

          <div className={styles.formGrid}>
            {QUANTITY_ORDER.map((quantity) => (
              <FormField
                key={quantity}
                label={`${QUANTITY_LABELS[quantity]} (${QUANTITY_UNITS[quantity]})`}
                htmlFor={`calc-${quantity}`}
              >
                <Input
                  id={`calc-${quantity}`}
                  inputMode="decimal"
                  value={fields[quantity]}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, [quantity]: e.target.value }))
                  }
                  placeholder="—"
                />
              </FormField>
            ))}
          </div>

          {blockingFailure && (
            <div className={styles.failure}>
              <ErrorState
                title="Cannot calculate from these values"
                description={explainFailure(blockingFailure)}
              />
            </div>
          )}

          {!blockingFailure && solved.length > 0 && (
            <dl className={styles.results}>
              {solved.map(({ quantity, outcome }) => {
                if (!outcome.ok) return null;
                return (
                  <div key={quantity} className={styles.result}>
                    <dt className={styles.resultLabel}>
                      {QUANTITY_LABELS[quantity]}
                    </dt>
                    <dd className={styles.resultValue}>
                      {formatQuantity(outcome.value, outcome.unit)}
                      <span className={styles.formula}>{outcome.formula}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}

          {suppliedCount < 2 && (
            <p className={styles.hint}>
              Enter two known values to calculate the rest.
            </p>
          )}

          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={reset}
              disabled={suppliedCount === 0}
            >
              Clear
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}
