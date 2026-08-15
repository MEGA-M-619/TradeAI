import Link from "next/link";
import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { CustomerDetailForm } from "@/components/CustomerDetailForm";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
}) {
  const { orgId, customerId } = await params;
  const { customer, jobs } = await withAuthenticatedOrgContext(
    orgId,
    async (tx, ctx) => {
      const customer = await customerRepository.getById(
        tx,
        ctx.orgId,
        customerId,
      );
      if (!customer) return { customer: null, jobs: [] };
      const jobs = await jobRepository.listForCustomer(
        tx,
        ctx.orgId,
        customerId,
      );
      return { customer, jobs };
    },
  );

  if (!customer) {
    notFound();
  }

  return (
    <div>
      <h1>{customer.name}</h1>
      <CustomerDetailForm orgId={orgId} customer={customer} />

      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p>No jobs for this customer yet.</p>
      ) : (
        <ul>
          {jobs.map((job) => (
            <li key={job.id}>
              <Link href={`/orgs/${orgId}/jobs/${job.id}`}>{job.title}</Link> (
              {job.status})
            </li>
          ))}
        </ul>
      )}
      <Link href={`/orgs/${orgId}/jobs?customerId=${customer.id}`}>
        Create a job for this customer
      </Link>
    </div>
  );
}
