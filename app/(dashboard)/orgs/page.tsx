import { redirect } from "next/navigation";
import { getAuthenticatedUserId } from "@/lib/auth/session";
import { organizationRepository } from "@/lib/db/repositories/organizationRepository";
import { Card, CardLink } from "@/components/ui";
import { CreateOrgForm } from "@/components/CreateOrgForm";
import styles from "./orgs.module.css";

export default async function OrgsPage() {
  const userId = await getAuthenticatedUserId();
  const organizations = await organizationRepository.listForUser(userId);

  // The common case -- a solo electrician with one business -- should
  // never see an org list at all. Only multi-org users (or first-time
  // users with none yet) land on this screen.
  if (organizations.length === 1) {
    redirect(`/orgs/${organizations[0].id}`);
  }

  if (organizations.length === 0) {
    return (
      <div className={styles.welcomeWrap}>
        <Card className={styles.welcomeCard}>
          <h1 className={styles.welcomeTitle}>Welcome to TradeAI</h1>
          <p className={styles.welcomeSubtitle}>
            TradeAI helps you manage your electrical jobs from the field. First,
            tell us the name of your business -- you can change it later.
          </p>
          <CreateOrgForm submitLabel="Get started" />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className={styles.title}>Your organizations</h1>
      <p className={styles.subtitle}>Choose which business you&apos;re working under.</p>
      <div className={styles.list}>
        {organizations.map((org) => (
          <CardLink key={org.id} href={`/orgs/${org.id}`}>
            {org.name}
          </CardLink>
        ))}
      </div>
      <Card className={styles.createCard}>
        <h2 className={styles.createTitle}>Add another organization</h2>
        <CreateOrgForm />
      </Card>
    </div>
  );
}
