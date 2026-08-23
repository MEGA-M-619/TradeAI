import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { evidenceRepository } from "@/lib/db/repositories/evidenceRepository";
import { assessmentRepository } from "@/lib/db/repositories/assessmentRepository";
import { materialRepository } from "@/lib/db/repositories/materialRepository";
import { quoteRepository } from "@/lib/db/repositories/quoteRepository";
import { createEvidenceDownloadUrls } from "@/lib/storage/evidenceStorage";
import { PageHeader, Card, StatusBadge, Badge, type BadgeVariant } from "@/components/ui";
import { ReportPrintButton } from "@/components/jobs/report/ReportPrintButton";
import styles from "./report.module.css";

type FindingKind = "observation" | "hypothesis";
type Confidence = "low" | "medium" | "high";
type VerdictKind = "confirmed" | "rejected" | "amended" | "unresolved";
type SafetySeverity = "advisory" | "mandatory" | "stop_work";

const KIND_LABEL: Record<FindingKind, string> = {
  observation: "Observation",
  hypothesis: "Hypothesis",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

// Same mapping AssessmentSection.tsx uses for a finding's verdict badge --
// kept in sync manually since this is a server component and that one is
// a client component (see the file header there for why they can't share
// the map directly).
const VERDICT_VARIANT: Record<VerdictKind, BadgeVariant> = {
  confirmed: "success",
  rejected: "danger",
  amended: "warning",
  unresolved: "neutral",
};

const VERDICT_LABEL: Record<VerdictKind, string> = {
  confirmed: "Confirmed",
  rejected: "Rejected",
  amended: "Amended",
  unresolved: "Unresolved",
};

const SEVERITY_VARIANT: Record<SafetySeverity, BadgeVariant> = {
  stop_work: "danger",
  mandatory: "warning",
  advisory: "neutral",
};

const SEVERITY_LABEL: Record<SafetySeverity, string> = {
  stop_work: "Stop work",
  mandatory: "Mandatory",
  advisory: "Advisory",
};

const ASSESSMENT_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  insufficient_evidence: "Insufficient evidence",
  failed: "Failed",
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCents(cents: number): string {
  return currencyFormatter.format(cents / 100);
}

function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default async function JobReportPage({
  params,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
}) {
  const { orgId, jobId } = await params;

  const data = await withAuthenticatedOrgContext(orgId, async (tx, ctx) => {
    const job = await jobRepository.getById(tx, ctx.orgId, jobId);
    if (!job) return null;

    const evidence = await evidenceRepository.listForJob(tx, ctx.orgId, jobId);
    const materials = await materialRepository.listForJob(tx, ctx.orgId, jobId);
    const quote = await quoteRepository.getForJob(tx, ctx.orgId, jobId);

    // The report shows the latest assessment run for this job, same as
    // AssessmentSection's default view -- listForJob orders by version
    // desc, so the first row is the latest regardless of its status.
    const assessments = await assessmentRepository.listForJob(tx, ctx.orgId, jobId);
    const latest = assessments[0] ?? null;
    const assessment = latest
      ? await assessmentRepository.getFullById(tx, ctx.orgId, jobId, latest.id)
      : null;

    return { job, evidence, materials, quote, assessment };
  });

  if (!data) {
    notFound();
  }
  const { job, evidence, materials, quote, assessment } = data;

  const urls = await createEvidenceDownloadUrls(evidence.map((e) => e.storageKey));

  const findings = assessment?.findings ?? [];
  // The one hard rule this page exists to enforce: "confirmed" here means
  // exactly finding.verdict.verdict === "confirmed" -- nothing else. A
  // rejected, amended, unresolved, or never-reviewed finding can never
  // appear in this list, regardless of how confident the model was.
  const confirmedFindings = findings.filter((f) => f.verdict?.verdict === "confirmed");
  const reviewCounts = {
    confirmed: findings.filter((f) => f.verdict?.verdict === "confirmed").length,
    rejected: findings.filter((f) => f.verdict?.verdict === "rejected").length,
    amended: findings.filter((f) => f.verdict?.verdict === "amended").length,
    unresolved: findings.filter((f) => f.verdict?.verdict === "unresolved").length,
    notReviewed: findings.filter((f) => f.verdict === null).length,
  };

  const materialsTotalCents = materials.reduce(
    (sum, m) => sum + Math.round(m.quantity * m.unitCostCents),
    0,
  );

  return (
    <div id="job-report-root" className={styles.reportRoot}>
      <div className={styles.noPrint}>
        <PageHeader
          title="Job report"
          backHref={`/orgs/${orgId}/jobs/${jobId}`}
          backLabel="Job"
          actions={<ReportPrintButton />}
        />
      </div>

      <header className={styles.printHeader}>
        <h1 className={styles.printTitle}>Job Report</h1>
        <p className={styles.printMeta}>Generated {formatDate(new Date())}</p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Customer information</h2>
        <Card>
          <dl className={styles.fieldList}>
            <div className={styles.field}>
              <dt>Name</dt>
              <dd>{job.customer.name}</dd>
            </div>
            {job.customer.phone && (
              <div className={styles.field}>
                <dt>Phone</dt>
                <dd>{job.customer.phone}</dd>
              </div>
            )}
            {job.customer.email && (
              <div className={styles.field}>
                <dt>Email</dt>
                <dd>{job.customer.email}</dd>
              </div>
            )}
            {job.customer.address && (
              <div className={styles.field}>
                <dt>Address</dt>
                <dd>{job.customer.address}</dd>
              </div>
            )}
          </dl>
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Job information</h2>
        <Card>
          <dl className={styles.fieldList}>
            <div className={styles.field}>
              <dt>Title</dt>
              <dd>{job.title}</dd>
            </div>
            <div className={styles.field}>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={job.status} />
              </dd>
            </div>
            <div className={styles.field}>
              <dt>Created</dt>
              <dd>{formatDate(job.createdAt)}</dd>
            </div>
          </dl>
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Job description</h2>
        <Card>
          <p className={styles.bodyText}>
            {job.problemDescription || "No description was recorded for this job."}
          </p>
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Photos</h2>
        {evidence.length === 0 ? (
          <Card>
            <p className={styles.bodyText}>No photos were attached to this job.</p>
          </Card>
        ) : (
          <div className={styles.photoGrid}>
            {evidence.map((item) => {
              const url = urls.get(item.storageKey) ?? null;
              return (
                <figure key={item.id} className={styles.photoTile}>
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={item.caption ?? "Job photo"} className={styles.photoImg} />
                  ) : (
                    <div className={styles.photoMissing}>Unavailable</div>
                  )}
                  {item.caption && <figcaption className={styles.photoCaption}>{item.caption}</figcaption>}
                </figure>
              );
            })}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>AI assessment summary</h2>
        {!assessment ? (
          <Card>
            <p className={styles.bodyText}>No AI assessment has been run for this job.</p>
          </Card>
        ) : (
          <Card>
            <dl className={styles.fieldList}>
              <div className={styles.field}>
                <dt>Status</dt>
                <dd>{ASSESSMENT_STATUS_LABEL[assessment.status] ?? assessment.status}</dd>
              </div>
              <div className={styles.field}>
                <dt>Model</dt>
                <dd>
                  {assessment.modelId} ({assessment.modelTier})
                </dd>
              </div>
              <div className={styles.field}>
                <dt>Run at</dt>
                <dd>{formatDate(assessment.createdAt)}</dd>
              </div>
            </dl>

            {assessment.status === "insufficient_evidence" && assessment.insufficientReason && (
              <p className={styles.noteBlock}>
                <strong>Insufficient evidence:</strong> {assessment.insufficientReason}
              </p>
            )}
            {assessment.status === "failed" && assessment.errorMessage && (
              <p className={styles.noteBlock}>
                <strong>Assessment failed:</strong> {assessment.errorMessage}
              </p>
            )}

            {findings.length > 0 && (
              <div className={styles.findingList}>
                <p className={styles.subheading}>
                  AI suggestions ({findings.length}) -- every item below is exactly what the
                  model proposed and how a technician has (or has not yet) reviewed it. Only
                  items separately listed under &quot;Confirmed findings&quot; are confirmed.
                </p>
                {findings.map((finding) => (
                  <div key={finding.id} className={styles.findingRow}>
                    <div className={styles.findingHeader}>
                      <Badge variant="neutral">{KIND_LABEL[finding.kind as FindingKind]}</Badge>
                      <Badge
                        variant={
                          finding.verdict
                            ? VERDICT_VARIANT[finding.verdict.verdict as VerdictKind]
                            : "neutral"
                        }
                      >
                        {finding.verdict
                          ? VERDICT_LABEL[finding.verdict.verdict as VerdictKind]
                          : "Not yet reviewed"}
                      </Badge>
                      <span className={styles.confidence}>
                        {CONFIDENCE_LABEL[finding.confidence as Confidence]}
                      </span>
                    </div>
                    <p className={styles.findingStatement}>{finding.statement}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Confirmed findings</h2>
        {confirmedFindings.length === 0 ? (
          <Card>
            <p className={styles.bodyText}>
              No AI findings have been confirmed by a technician for this job.
            </p>
          </Card>
        ) : (
          <div className={styles.findingList}>
            {confirmedFindings.map((finding) => (
              <Card key={finding.id} padding="sm">
                <div className={styles.findingHeader}>
                  <Badge variant="neutral">{KIND_LABEL[finding.kind as FindingKind]}</Badge>
                  <Badge variant="success">Confirmed</Badge>
                </div>
                <p className={styles.findingStatement}>{finding.statement}</p>
                {finding.verdict?.note && (
                  <p className={styles.noteBlock}>
                    <strong>Technician note:</strong> {finding.verdict.note}
                  </p>
                )}
                {finding.verdict && (
                  <p className={styles.reviewMeta}>
                    Confirmed {formatDate(finding.verdict.createdAt)}
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Safety warnings</h2>
        {!assessment || assessment.safetyWarnings.length === 0 ? (
          <Card>
            <p className={styles.bodyText}>No safety warnings were recorded for this job.</p>
          </Card>
        ) : (
          <div className={styles.list}>
            {assessment.safetyWarnings.map((warning) => (
              <Card key={warning.id} padding="sm">
                <div className={styles.findingHeader}>
                  <Badge variant={SEVERITY_VARIANT[warning.severity as SafetySeverity]}>
                    {SEVERITY_LABEL[warning.severity as SafetySeverity]}
                  </Badge>
                </div>
                <p className={styles.bodyText}>{warning.message}</p>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Unknowns / limitations</h2>
        <Card>
          {!assessment || assessment.limitations.length === 0 ? (
            <p className={styles.bodyText}>
              No limitations were stated by the AI assessment for this job.
            </p>
          ) : (
            <ul className={styles.plainList}>
              {assessment.limitations.map((limitation, index) => (
                <li key={index}>{limitation}</li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Technician review</h2>
        <Card>
          {findings.length === 0 ? (
            <p className={styles.bodyText}>There are no AI findings to review for this job.</p>
          ) : (
            <p className={styles.bodyText}>
              {reviewCounts.confirmed} of {findings.length} AI finding
              {findings.length === 1 ? "" : "s"} confirmed by a technician
              {reviewCounts.rejected > 0 && `, ${reviewCounts.rejected} rejected`}
              {reviewCounts.amended > 0 && `, ${reviewCounts.amended} amended`}
              {reviewCounts.unresolved > 0 && `, ${reviewCounts.unresolved} left unresolved`}
              {reviewCounts.notReviewed > 0 && `, ${reviewCounts.notReviewed} not yet reviewed`}.
            </p>
          )}
        </Card>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Materials</h2>
        {materials.length === 0 ? (
          <Card>
            <p className={styles.bodyText}>No materials were recorded for this job.</p>
          </Card>
        ) : (
          <>
            <div className={styles.list}>
              {materials.map((material) => (
                <Card key={material.id} padding="sm">
                  <div className={styles.row}>
                    <span>{material.description}</span>
                    <span className={styles.rowValue}>
                      {material.quantity} x {formatCents(material.unitCostCents)} ={" "}
                      {formatCents(Math.round(material.quantity * material.unitCostCents))}
                    </span>
                  </div>
                </Card>
              ))}
            </div>
            <div className={styles.totalsRowFinal}>
              <span>Materials total</span>
              <span>{formatCents(materialsTotalCents)}</span>
            </div>
          </>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Quote</h2>
        {!quote ? (
          <Card>
            <p className={styles.bodyText}>No quote has been generated for this job yet.</p>
          </Card>
        ) : (
          <>
            <div className={styles.list}>
              {quote.lineItems.map((item) => (
                <Card key={item.id} padding="sm">
                  <div className={styles.row}>
                    <div>
                      <Badge variant={item.kind === "material" ? "neutral" : "success"}>
                        {item.kind === "material" ? "Material" : "Labor"}
                      </Badge>{" "}
                      <span>{item.description}</span>
                    </div>
                    <span className={styles.rowValue}>
                      {item.quantity} x {formatCents(item.unitPriceCents)} ={" "}
                      {formatCents(item.lineTotalCents)}
                    </span>
                  </div>
                </Card>
              ))}
            </div>
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
          </>
        )}
      </section>
    </div>
  );
}
