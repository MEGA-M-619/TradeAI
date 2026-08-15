import Link from "next/link";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { CreateOrgForm } from "@/components/CreateOrgForm";

export default async function OrgsPage() {
  const userId = await getAuthenticatedUserId();
  const organizations = await organizationRepository.listForUser(userId);

  return (
    <div>
      <h1>Your organizations</h1>
      {organizations.length === 0 ? (
        <p>You don&apos;t belong to any organization yet.</p>
      ) : (
        <ul>
          {organizations.map((org) => (
            <li key={org.id}>
              <Link href={`/orgs/${org.id}`}>{org.name}</Link>
            </li>
          ))}
        </ul>
      )}
      <h2>Create a new organization</h2>
      <CreateOrgForm />
    </div>
  );
}
