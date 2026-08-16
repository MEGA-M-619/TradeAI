import { redirect } from "next/navigation";
import {
  ensureCurrentUserProfile,
  UnauthenticatedError,
} from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { AppShell } from "@/components/shell/AppShell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let userId: string;
  try {
    // Also provisions the users profile row on first authenticated visit
    // -- see lib/auth/session.ts.
    userId = await ensureCurrentUserProfile();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/login");
    }
    throw error;
  }

  const organizations = await organizationRepository.listForUser(userId);

  return <AppShell organizations={organizations}>{children}</AppShell>;
}
