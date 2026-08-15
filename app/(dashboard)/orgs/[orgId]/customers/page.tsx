import Link from "next/link";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { customerRepository } from "@/lib/db/repositories/customerRepository";
import { CreateCustomerForm } from "@/components/CreateCustomerForm";

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const customers = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
    customerRepository.listForOrg(tx, ctx.orgId),
  );

  return (
    <div>
      <h1>Customers</h1>
      {customers.length === 0 ? (
        <p>No customers yet.</p>
      ) : (
        <ul>
          {customers.map((customer) => (
            <li key={customer.id}>
              <Link href={`/orgs/${orgId}/customers/${customer.id}`}>
                {customer.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2>Add a customer</h2>
      <CreateCustomerForm orgId={orgId} />
    </div>
  );
}
