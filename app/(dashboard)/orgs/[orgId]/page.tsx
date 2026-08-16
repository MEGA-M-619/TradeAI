import { redirect } from "next/navigation";

// Jobs is the practical home of TradeAI -- an org "home" screen with no
// content of its own just adds a click. See the Phase 1.5 audit.
export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/orgs/${orgId}/jobs`);
}
