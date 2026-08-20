import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { measurementRepository } from "@/lib/db/repositories/measurementRepository";
import { circuitRepository } from "@/lib/db/repositories/circuitRepository";
import { diagnosticSessionRepository } from "@/lib/db/repositories/diagnosticSessionRepository";
import { createEvidenceDownloadUrls } from "@/lib/storage/evidenceStorage";
import { MAX_EVIDENCE_PER_JOB } from "@/lib/validation/evidence";
import { MAX_ASSESSMENT_IMAGES } from "@/lib/validation/assessment";
import {
  MEASUREMENT_TEST_TYPES,
  ALLOWED_UNITS_BY_TEST_TYPE,
} from "@/lib/validation/measurement";
import { JobWorkspace } from "@/components/jobs/JobWorkspace";
import type { EvidenceItem } from "@/components/jobs/EvidenceSection";
import type { AssessmentSummary } from "@/components/jobs/AssessmentSection";
import type {
  MeasurementItem,
  CircuitOption,
} from "@/components/jobs/MeasurementsSection";
import type { DiagnosticSessionSummary } from "@/components/jobs/DiagnosticsSection";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
}) {
  const { orgId, jobId } = await params;
  const { job, evidence, assessments, measurements, circuits, sessions } =
    await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
      const job = await jobRepository.getById(tx, ctx.orgId, jobId);
      if (!job) {
        return {
          job: null,
          evidence: [],
          assessments: [],
          measurements: [],
          circuits: [],
          sessions: [],
        };
      }
      const evidence = await evidenceRepository.listForJob(tx, ctx.orgId, jobId);
      const assessments = await assessmentRepository.listForJob(tx, ctx.orgId, jobId);
      const measurements = await measurementRepository.listForJob(tx, ctx.orgId, jobId);
      // Circuits belong to the customer, not the job -- they persist
      // across visits, so the picker offers every circuit already known
      // for this customer.
      const circuits = await circuitRepository.listForCustomer(
        tx,
        ctx.orgId,
        job.customerId,
      );
      const sessions = await diagnosticSessionRepository.listForJob(
        tx,
        ctx.orgId,
        jobId,
      );
      return { job, evidence, assessments, measurements, circuits, sessions };
    });

  if (!job) {
    notFound();
  }

  // Signed URLs are minted per render and expire quickly, so they are
  // produced here rather than stored. Batched into a single Storage call
  // for the whole grid.
  const urls = await createEvidenceDownloadUrls(evidence.map((e) => e.storageKey));

  const evidenceItems: EvidenceItem[] = evidence.map((e) => ({
    id: e.id,
    caption: e.caption,
    width: e.width,
    height: e.height,
    createdAt: e.createdAt.toISOString(),
    url: urls.get(e.storageKey) ?? null,
  }));

  const assessmentSummaries: AssessmentSummary[] = assessments.map((a) => ({
    id: a.id,
    version: a.version,
    status: a.status,
    modelTier: a.modelTier,
    createdAt: a.createdAt.toISOString(),
  }));

  const measurementItems: MeasurementItem[] = measurements.map((m) => ({
    id: m.id,
    testType: m.testType,
    circuitId: m.circuitId,
    value: m.value,
    unit: m.unit,
    expectedMin: m.expectedMin,
    expectedMax: m.expectedMax,
    result: m.result,
    note: m.note,
    recordedAt: m.recordedAt.toISOString(),
  }));

  const circuitOptions: CircuitOption[] = circuits.map((c) => ({
    id: c.id,
    label: c.label,
    panelLabel: c.panelLabel,
  }));

  const sessionSummaries: DiagnosticSessionSummary[] = sessions.map((s) => ({
    id: s.id,
    symptom: s.symptom,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
  }));

  return (
    <JobWorkspace
      orgId={orgId}
      job={job}
      evidence={evidenceItems}
      evidenceLimit={MAX_EVIDENCE_PER_JOB}
      assessments={assessmentSummaries}
      maxAssessmentImages={MAX_ASSESSMENT_IMAGES}
      measurements={measurementItems}
      circuits={circuitOptions}
      diagnosticSessions={sessionSummaries}
      measurementTestTypes={MEASUREMENT_TEST_TYPES}
      allowedUnits={ALLOWED_UNITS_BY_TEST_TYPE}
    />
  );
}
