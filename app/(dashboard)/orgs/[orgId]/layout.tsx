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

  // Navigation lives in AppShell (app/(dashboard)/layout.tsx), which
  // reads the current org from the URL -- this layout's only job is the
  // membership check above.
  return children;
}
