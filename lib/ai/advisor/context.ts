import { createHash } from "node:crypto";
import type { TenantTxClient } from "@/lib/db/tenantContext";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { buildSafetyFacts } from "@/lib/safety/factBuilder";
import { evaluateSafety } from "@/lib/safety/evaluate";
import { isKnown } from "@/lib/safety/facts";
import type { AdvisorContext, AdvisorMeasurement } from "@/lib/ai/advisor/schema";

/**
 * Builds the authoritative context the model is allowed to see.
 *
 * The whole point is that the server derives this itself from persisted
 * rows and the deterministic engines. Nothing here is accepted from a
 * request body: a caller supplies route params and a question, and cannot
 * manufacture a measurement, an evaluation, or a safety state and have
 * the model treat it as fact.
 *
 * It is also a data-minimisation boundary. The model receives this job's
 * readings, this session's causes, and the safety verdict -- not the
 * customer's name, address, phone or email, not other jobs, not other
 * organizations, not user identities, and not storage keys or ids beyond
 * the measurement and cause ids it must cite.
 *
 * Reads run through the same repositories and the same org-scoped
 * transaction as everything else, so RLS applies unchanged.
 */

export type AdvisorContextResult = {
  context: AdvisorContext;
  /** Identifies the deterministic state this context was built from, so
   * advice can be marked stale once that state moves. */
  fingerprint: string;
};

export async function buildAdvisorContext(
  tx: TenantTxClient,
  orgId: string,
  jobId: string,
  sessionId: string,
): Promise<AdvisorContextResult | null> {
  const session = await diagnosticSessionRepository.getFullById(
    tx,
    orgId,
    jobId,
    sessionId,
  );
  if (!session) return null;

  const job = await jobRepository.getById(tx, orgId, jobId);
  if (!job) return null;

  const measurementRows = await measurementRepository.listForJob(
    tx,
    orgId,
    jobId,
  );
  const circuits = await circuitRepository.listForCustomer(
    tx,
    orgId,
    job.customerId,
  );
  const circuitLabelById = new Map(circuits.map((c) => [c.id, c.label]));

  // The safety verdict is computed here, from the same facts, rather than
  // being passed in -- so what the model is told is what the Safety
  // Engine actually says, not a caller's copy of it.
  const facts = await buildSafetyFacts(tx, orgId, jobId, sessionId);
  const safety = evaluateSafety(facts);

  const circuitFact = facts.circuit_under_investigation;
  const identifiedCircuit = isKnown(circuitFact)
    ? (circuits.find((c) => c.id === circuitFact.value.circuitId) ?? null)
    : null;

  const measurements: AdvisorMeasurement[] = measurementRows.map((m) => ({
    id: m.id,
    testType: m.testType,
    value: m.value,
    unit: m.unit,
    expectedMin: m.expectedMin,
    expectedMax: m.expectedMax,
    criterionSource:
      m.expectedMin === null && m.expectedMax === null
        ? "none"
        : "technician_supplied",
    evaluation: m.result,
    circuitLabel: m.circuitId
      ? (circuitLabelById.get(m.circuitId) ?? null)
      : null,
    recordedAt: m.recordedAt.toISOString(),
    note: m.note,
  }));

  const evidence = await evidenceRepository.listForJob(tx, orgId, jobId);

  const context: AdvisorContext = {
    job: {
      title: job.title,
      problemDescription: job.problemDescription,
    },
    circuit: identifiedCircuit
      ? {
          label: identifiedCircuit.label,
          panelLabel: identifiedCircuit.panelLabel,
        }
      : null,
    circuitUnknownReason: isKnown(circuitFact)
      ? null
      : `${circuitFact.reason}: ${circuitFact.detail}`,
    session: { symptom: session.symptom, status: session.status },
    measurements,
    causes: session.causes.map((c) => ({
      id: c.id,
      statement: c.statement,
      status: c.status,
      recommendedNextTest: c.recommendedNextTest,
      resolvingMeasurementId: c.resolvingMeasurementId,
    })),
    // A count, not the photos. Image reasoning belongs to the existing
    // assessment pipeline; the advisor is told only that photos exist so
    // it can point at them rather than pretend to have seen them.
    evidenceCount: evidence.length,
    safety: {
      state: safety.state,
      rulesetVersion: safety.rulesetVersion,
      firedRuleIds: [...safety.firedRuleIds],
      findings: safety.findings.map((f) => ({
        ruleId: f.ruleId,
        message: f.message,
      })),
      verifications: [...safety.verifications],
      unknownFacts: [...safety.unknownFacts],
      precautions: safety.precautions.map((p) => p.message),
    },
  };

  return { context, fingerprint: fingerprintOf(context) };
}

/**
 * A stable digest of the deterministic state. Deliberately covers only
 * what would change the reasoning -- readings and their evaluations,
 * cause statuses, the circuit, and the safety verdict -- so editing an
 * unrelated job field does not needlessly invalidate advice, while
 * recording a reading does.
 */
export function fingerprintOf(context: AdvisorContext): string {
  const material = JSON.stringify({
    circuit: context.circuit?.label ?? null,
    symptom: context.session.symptom,
    sessionStatus: context.session.status,
    measurements: context.measurements
      .map((m) => `${m.id}:${m.value}:${m.unit}:${m.evaluation ?? "null"}`)
      .sort(),
    causes: context.causes
      .map((c) => `${c.id}:${c.status}:${c.resolvingMeasurementId ?? "null"}`)
      .sort(),
    safety: `${context.safety.state}:${context.safety.rulesetVersion}:${[
      ...context.safety.firedRuleIds,
    ]
      .sort()
      .join(",")}`,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
