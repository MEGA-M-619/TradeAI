import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ensureCurrentUserProfile,
  UnauthenticatedError,
} from "@/lib/auth/session";
import { SignOutButton } from "@/components/SignOutButton";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    // Also provisions the users profile row on first authenticated visit
    // -- see lib/auth/session.ts.
    await ensureCurrentUserProfile();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <div>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--foreground)",
        }}
      >
        <Link href="/orgs">TradeAI</Link>
        <SignOutButton />
      </header>
      <main style={{ padding: "1rem" }}>{children}</main>
    </div>
  );
}
