import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const organization = await withAuthenticatedOrgContext(orgId, (tx, ctx) =>
    organizationRepository.getCurrent(tx, ctx.orgId),
  );
  if (!organization) {
    notFound();
  }

  return (
    <div>
      <h1>{organization.name}</h1>
      <p>Use the navigation above to manage customers and jobs.</p>
    </div>
  );
}
