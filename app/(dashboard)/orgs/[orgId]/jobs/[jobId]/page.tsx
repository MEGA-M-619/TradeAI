import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { createEvidenceDownloadUrls } from "@/lib/storage/evidenceStorage";
import { MAX_EVIDENCE_PER_JOB } from "@/lib/validation/evidence";
import { MAX_ASSESSMENT_IMAGES } from "@/lib/validation/assessment";
import { JobWorkspace } from "@/components/jobs/JobWorkspace";
import type { EvidenceItem } from "@/components/jobs/EvidenceSection";
import type { AssessmentSummary } from "@/components/jobs/AssessmentSection";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
}) {
  const { orgId, jobId } = await params;
  const { job, evidence, assessments } = await withAuthenticatedOrgContext(
    orgId,
    async (tx, ctx) => {
      const job = await jobRepository.getById(tx, ctx.orgId, jobId);
      if (!job) return { job: null, evidence: [], assessments: [] };
      const evidence = await evidenceRepository.listForJob(tx, ctx.orgId, jobId);
      const assessments = await assessmentRepository.listForJob(tx, ctx.orgId, jobId);
      return { job, evidence, assessments };
    },
  );

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

  return (
    <JobWorkspace
      orgId={orgId}
      job={job}
      evidence={evidenceItems}
      evidenceLimit={MAX_EVIDENCE_PER_JOB}
      assessments={assessmentSummaries}
      maxAssessmentImages={MAX_ASSESSMENT_IMAGES}
    />
  );
}
