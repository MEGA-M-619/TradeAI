import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { JobsPageContent } from "@/components/jobs/JobsPageContent";

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
    <JobsPageContent
      orgId={orgId}
      jobs={jobs}
      customers={customers}
      initialCustomerId={customerId}
    />
  );
}
