import { notFound } from "next/navigation";
import { withAuthenticatedOrgContext } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { membershipRepository } from "@/lib/db/repositories/membershipRepository";
import { PageHeader, Card, Avatar } from "@/components/ui";
import { SignOutButton } from "@/components/SignOutButton";
import styles from "./settings.module.css";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { organization, memberships } = await withAuthenticatedOrgContext(
    orgId,
    async (tx, ctx) => {
      const organization = await organizationRepository.getCurrent(tx, ctx.orgId);
      const memberships = await membershipRepository.listForOrg(tx, ctx.orgId);
      return { organization, memberships };
    },
  );

  if (!organization) {
    notFound();
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle={organization.name} />

      <Card>
        <h2 className={styles.sectionTitle}>Members</h2>
        <ul className={styles.memberList}>
          {memberships.map((membership) => (
            <li key={membership.id} className={styles.memberRow}>
              <Avatar name={membership.user.fullName ?? membership.user.email} />
              <div className={styles.memberInfo}>
                <p className={styles.memberName}>
                  {membership.user.fullName ?? membership.user.email}
                </p>
                <p className={styles.memberRole}>{membership.role}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <div className={styles.signOutRow}>
        <SignOutButton />
      </div>
    </div>
  );
}
