import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { CustomersPageContent } from "@/components/customers/CustomersPageContent";

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const customers = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
    customerRepository.listForOrg(tx, ctx.orgId),
  );

  return <CustomersPageContent orgId={orgId} customers={customers} />;
}
