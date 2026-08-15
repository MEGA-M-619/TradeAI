import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getAuthenticatedUserId,
  resolveOrgContext,
  ForbiddenOrgAccessError,
} from "@/lib/auth/session";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const userId = await getAuthenticatedUserId();
  try {
    await resolveOrgContext(userId, orgId);
  } catch (error) {
    if (error instanceof ForbiddenOrgAccessError) {
      redirect("/orgs");
    }
    throw error;
  }

  return (
    <div>
      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <Link href={`/orgs/${orgId}/customers`}>Customers</Link>
        <Link href={`/orgs/${orgId}/jobs`}>Jobs</Link>
        <Link href="/orgs">Switch organization</Link>
      </nav>
      {children}
    </div>
  );
}
