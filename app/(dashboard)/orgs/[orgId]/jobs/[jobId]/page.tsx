import Link from "next/link";
import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { JobDetailForm } from "@/components/JobDetailForm";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; jobId: string }>;
}) {
  const { orgId, jobId } = await params;
  const job = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
    jobRepository.getById(tx, ctx.orgId, jobId),
  );

  if (!job) {
    notFound();
  }

  return (
    <div>
      <h1>{job.title}</h1>
      <p>
        Customer:{" "}
        <Link href={`/orgs/${orgId}/customers/${job.customer.id}`}>
          {job.customer.name}
        </Link>
      </p>
      <JobDetailForm orgId={orgId} job={job} />
    </div>
  );
}
