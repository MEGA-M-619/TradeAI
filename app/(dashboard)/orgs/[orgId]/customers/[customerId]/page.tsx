import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { jobRepository } from "@/lib/db/repositories/jobRepository";
import {
  PageHeader,
  Card,
  CardLink,
  StatusBadge,
  EmptyState,
  LinkButton,
} from "@/components/ui";
import { CustomerDetailForm } from "@/components/CustomerDetailForm";
import styles from "./customerDetail.module.css";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
}) {
  const { orgId, customerId } = await params;
  const { customer, jobs } = await withAuthenticatedOrgContext(
    orgId,
    async (tx, ctx) => {
      const customer = await customerRepository.getById(tx, ctx.orgId, customerId);
      if (!customer) return { customer: null, jobs: [] };
      const jobs = await jobRepository.listForCustomer(tx, ctx.orgId, customerId);
      return { customer, jobs };
    },
  );

  if (!customer) {
    notFound();
  }

  const newJobHref = `/orgs/${orgId}/jobs?customerId=${customer.id}`;

  return (
    <div>
      <PageHeader
        title={customer.name}
        backHref={`/orgs/${orgId}/customers`}
        backLabel="Customers"
      />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Customer information</h2>
        <Card>
          <CustomerDetailForm orgId={orgId} customer={customer} />
        </Card>
      </section>

      <section className={styles.section}>
        <div className={styles.jobsHeader}>
          <h2 className={styles.sectionTitle}>Jobs</h2>
          {jobs.length > 0 && (
            <LinkButton href={newJobHref} variant="secondary" size="sm">
              + New Job
            </LinkButton>
          )}
        </div>

        {jobs.length === 0 ? (
          <EmptyState
            title="No jobs for this customer yet"
            description="Create a job to start documenting work for this customer."
            action={
              <LinkButton href={newJobHref} variant="primary">
                + New Job
              </LinkButton>
            }
          />
        ) : (
          <div>
            {jobs.map((job) => (
              <CardLink key={job.id} href={`/orgs/${orgId}/jobs/${job.id}`}>
                <div className={styles.jobRow}>
                  <span className={styles.jobTitle}>{job.title}</span>
                  <StatusBadge status={job.status} />
                </div>
              </CardLink>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
