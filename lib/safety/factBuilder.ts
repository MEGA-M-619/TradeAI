/**
 * Builds SafetyFacts from persisted, server-side data. This is the only
 * module in lib/safety that touches the database, and it does so solely
 * through lib/db/repositories/* inside an already org-scoped transaction
 * -- never `prisma.<model>` directly, and never a raw query.
 *
 * Everything it produces comes from rows a technician deliberately
 * recorded through an authenticated, tenant-scoped write path. Nothing
 * here reads a request body, a query string, a header, or any model
 * output: a fact is something the database establishes, and a caller
 * cannot assert one. That is what makes the safety evaluation
 * unforgeable from the client side -- there is no parameter through
 * which a state, a severity, a rule id, or a verification item could be
 * supplied.
 *
 * Failing closed is the default everywhere. If the session cannot be
 * read -- because it does not exist, belongs to another job, or the
 * caller's org context does not grant access -- every fact comes back
 * Unknown rather than empty, and the evaluator escalates. An
 * unreadable session must never look like a session with nothing wrong
 * with it.
 *
 * No thresholds, no standards, no compliance claims: this module
 * reports what was recorded and marks what it could not establish.
 */

import type { TenantTxClient } from "@/lib/db/tenantContext";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import {
  SAFETY_CATEGORIES,
  type SafetyCategory,
} from "@/lib/validation/assessment";
import {
  known,
  unknown,
  type MeasurementCriterion,
  type MeasurementFact,
  type SafetyFacts,
} from "@/lib/safety/facts";

/** The measurement row shape this module consumes. Declared structurally
 * rather than imported from the Prisma client so the safety layer stays
 * independent of the generated types. */
type MeasurementRow = {
  id: string;
  testType: MeasurementFact["testType"];
  circuitId: string | null;
  value: number;
  unit: string;
  expectedMin: number | null;
  expectedMax: number | null;
  result: MeasurementFact["result"];
  recordedAt: Date;
};

/**
 * A range the technician typed into the request body
 * (lib/validation/measurement.ts) is their own expectation, not a
 * verified standard -- so it is recorded as `technician_supplied` and
 * carried through to every finding's `criterionSource`. A row with
 * neither bound had no criterion at all.
 *
 * There is no branch producing a verified source, because no verified
 * source exists in this repository.
 */
function criterionOf(row: MeasurementRow): MeasurementCriterion {
  if (row.expectedMin === null && row.expectedMax === null) {
    return { source: "none" };
  }
  return {
    source: "technician_supplied",
    expectedMin: row.expectedMin,
    expectedMax: row.expectedMax,
  };
}

function toMeasurementFact(row: MeasurementRow): MeasurementFact {
  return {
    measurementId: row.id,
    testType: row.testType,
    circuitId: row.circuitId,
    value: row.value,
    unit: row.unit,
    // Passed through exactly as stored, including null. A row predating
    // the measurement-result wiring is "not evaluated", never "fine".
    result: row.result,
    criterion: criterionOf(row),
    recordedAt: row.recordedAt.toISOString(),
  };
}

/**
 * Sorted by (recordedAt, id). The repository already orders by
 * recordedAt, but equal timestamps leave Postgres free to return rows in
 * any order, so the id breaks ties and makes the fact set byte-stable
 * across evaluations of identical data.
 */
function sortMeasurements(
  measurements: readonly MeasurementFact[],
): MeasurementFact[] {
  return [...measurements].sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) {
      return a.recordedAt < b.recordedAt ? -1 : 1;
    }
    return a.measurementId < b.measurementId ? -1 : 1;
  });
}

/** Every fact Unknown, for the paths where nothing can be established.
 * Deliberately not "empty" -- an unreadable session is a different
 * statement from a session with no data, and only the latter is a fact. */
function allUnknown(detail: string): SafetyFacts {
  return {
    circuit_under_investigation: unknown("not_recorded", detail),
    measurements_on_job: unknown("not_recorded", detail),
    measurements_on_circuit: unknown("depends_on_unknown_fact", detail),
    ai_hazard_categories: unknown("not_recorded", detail),
  };
}

function isSafetyCategory(value: string): value is SafetyCategory {
  return (SAFETY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Hazard categories from the latest *completed* assessment for this job.
 *
 * Three filters, each load-bearing:
 *   - Only a `complete` assessment counts. A queued, running or failed run
 *     has no persisted findings anyway (a failed one rolls back), so
 *     reading anything else would be reading nothing while looking like
 *     it read something.
 *   - Findings the technician explicitly rejected are dropped. A rejection
 *     is a deterministic human act, and letting it clear a hallucinated
 *     flag is a change in the facts, not a downgrade of a verdict --
 *     without it, one bad generation alarms forever.
 *   - Every category is re-checked against the closed SAFETY_CATEGORIES
 *     vocabulary on the way out. The column is a widened `String[]`, so
 *     this is the gate that keeps arbitrary text from becoming a fact even
 *     if something ever wrote it.
 *
 * Returns [] rather than throwing when there is nothing to read: absence
 * of an assessment is a fact, not an unknown.
 */
async function loadAiHazardCategories(
  tx: TenantTxClient,
  orgId: string,
  jobId: string,
): Promise<SafetyCategory[]> {
  // listForJob is ordered by version desc, so the first `complete` row is
  // the latest one.
  const assessments = await assessmentRepository.listForJob(tx, orgId, jobId);
  const latestComplete = assessments.find(
    (assessment) => assessment.status === "complete",
  );
  if (!latestComplete) return [];

  const full = await assessmentRepository.getFullById(
    tx,
    orgId,
    jobId,
    latestComplete.id,
  );
  if (!full) return [];

  const categories = new Set<SafetyCategory>();
  for (const finding of full.findings) {
    if (finding.verdict?.verdict === "rejected") continue;
    for (const raw of finding.safetyCategories) {
      if (isSafetyCategory(raw)) categories.add(raw);
    }
  }
  // Sorted so identical data yields an identical fact set.
  return [...categories].sort();
}

/**
 * Gathers the facts for one diagnostic session.
 *
 * `tx` must already carry a verified org context (from
 * withAuthenticatedOrgContext). `orgId`, `jobId` and `sessionId` come
 * from verified route params, never from a request body. Every read is
 * additionally scoped by orgId at the repository layer and by RLS at the
 * database, so a forged or missing org context yields no rows and every
 * fact returns Unknown.
 */
export async function buildSafetyFacts(
  tx: TenantTxClient,
  orgId: string,
  jobId: string,
  sessionId: string,
): Promise<SafetyFacts> {
  // The session must be readable under this context and belong to this
  // job. A caller pairing a real session id with the wrong job, or with
  // an org they are not a member of, gets Unknown facts rather than a
  // silently job-wide evaluation.
  const session = await diagnosticSessionRepository.getById(
    tx,
    orgId,
    jobId,
    sessionId,
  );
  if (!session) {
    return allUnknown(
      "the diagnostic session could not be read under this organization context",
    );
  }

  const job = await jobRepository.getById(tx, orgId, jobId);
  if (!job) {
    return allUnknown(
      "the job could not be read under this organization context",
    );
  }

  const rows = (await measurementRepository.listForJob(
    tx,
    orgId,
    jobId,
  )) as MeasurementRow[];
  const measurementsOnJob = sortMeasurements(rows.map(toMeasurementFact));

  // Independent of the circuit, so it is established once and carried on
  // every return path below.
  const aiHazardCategories = known(
    await loadAiHazardCategories(tx, orgId, jobId),
  );

  // The circuit under investigation is derived, because DiagnosticSession
  // has no circuitId column: it is the single circuit every attributed
  // measurement on this job points at. None means nothing was attributed;
  // several means the job spans more than one circuit and this session
  // cannot be pinned to one of them.
  const referencedCircuitIds = [
    ...new Set(
      measurementsOnJob
        .map((measurement) => measurement.circuitId)
        .filter((circuitId): circuitId is string => circuitId !== null),
    ),
  ].sort();

  if (referencedCircuitIds.length === 0) {
    return {
      circuit_under_investigation: unknown(
        "not_recorded",
        "no measurement on this job references a circuit",
      ),
      measurements_on_job: known(measurementsOnJob),
      measurements_on_circuit: unknown(
        "depends_on_unknown_fact",
        "the circuit under investigation is not identified",
      ),
      ai_hazard_categories: aiHazardCategories,
    };
  }

  if (referencedCircuitIds.length > 1) {
    return {
      circuit_under_investigation: unknown(
        "ambiguous",
        `measurements on this job reference ${referencedCircuitIds.length} different circuits`,
      ),
      measurements_on_job: known(measurementsOnJob),
      measurements_on_circuit: unknown(
        "depends_on_unknown_fact",
        "the circuit under investigation is not identified",
      ),
      ai_hazard_categories: aiHazardCategories,
    };
  }

  const circuitId = referencedCircuitIds[0];
  const circuit = await circuitRepository.getById(
    tx,
    orgId,
    job.customerId,
    circuitId,
  );
  if (!circuit) {
    // Referenced but unreadable: the row exists on the measurement, but
    // the circuit itself is not visible under this context or does not
    // belong to this job's customer. Not identified.
    return {
      circuit_under_investigation: unknown(
        "not_recorded",
        "the referenced circuit could not be read for this job's customer",
      ),
      measurements_on_job: known(measurementsOnJob),
      measurements_on_circuit: unknown(
        "depends_on_unknown_fact",
        "the circuit under investigation is not identified",
      ),
      ai_hazard_categories: aiHazardCategories,
    };
  }

  // Scoped to this job on purpose. The session concerns this visit, so
  // readings from other jobs on the same circuit are job-memory context,
  // not facts about the situation being evaluated here.
  const measurementsOnCircuit = measurementsOnJob.filter(
    (measurement) => measurement.circuitId === circuitId,
  );

  return {
    circuit_under_investigation: known({
      circuitId: circuit.id,
      label: circuit.label,
    }),
    measurements_on_job: known(measurementsOnJob),
    measurements_on_circuit: known(measurementsOnCircuit),
    ai_hazard_categories: aiHazardCategories,
  };
}
