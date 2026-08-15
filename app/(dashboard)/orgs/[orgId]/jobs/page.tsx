import Link from "next/link";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { CreateJobForm } from "@/components/CreateJobForm";

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ customerId?: string }>;
}) {
  const { orgId } = await params;
  const { customerId } = await searchParams;
  const { jobs, customers } = await withAuthenticatedOrgContext(
    orgId,
    async (tx, ctx) => {
      const jobs = await jobRepository.listForOrg(tx, ctx.orgId);
      const customers = await customerRepository.listForOrg(tx, ctx.orgId);
      return { jobs, customers };
    },
  );

  return (
    <div>
      <h1>Jobs</h1>
      {jobs.length === 0 ? (
        <p>No jobs yet.</p>
      ) : (
        <ul>
          {jobs.map((job) => (
            <li key={job.id}>
              <Link href={`/orgs/${orgId}/jobs/${job.id}`}>{job.title}</Link> —{" "}
              {job.customer.name} ({job.status})
            </li>
          ))}
        </ul>
      )}
      <h2>Create a job</h2>
      <CreateJobForm
        orgId={orgId}
        customers={customers}
        initialCustomerId={customerId}
      />
    </div>
  );
}
