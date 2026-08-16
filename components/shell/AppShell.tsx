"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./AppShell.module.css";
import { OrgSwitcher } from "./OrgSwitcher";
import { JobsIcon, CustomersIcon, SettingsIcon } from "./NavIcons";
import { SignOutButton } from "@/components/SignOutButton";

const ORG_PATH_PATTERN = /^\/orgs\/([^/]+)/;

type OrgOption = { id: string; name: string };

export function AppShell({
  organizations,
  children,
}: {
  organizations: OrgOption[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const orgMatch = pathname.match(ORG_PATH_PATTERN);
  const orgId = orgMatch ? orgMatch[1] : null;

  const navItems = orgId
    ? [
        { href: `/orgs/${orgId}/jobs`, label: "Jobs", Icon: JobsIcon },
        { href: `/orgs/${orgId}/customers`, label: "Customers", Icon: CustomersIcon },
        { href: `/orgs/${orgId}/settings`, label: "Settings", Icon: SettingsIcon },
      ]
    : [];

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/orgs" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            T
          </span>
          TradeAI
        </Link>
        {orgId ? (
          <OrgSwitcher organizations={organizations} currentOrgId={orgId} />
        ) : (
          // When there's no org context, the sidebar/Settings sign-out
          // path isn't rendered at all -- this is the only way to sign
          // out from the org list/create screen.
          <SignOutButton variant="ghost" />
        )}
      </header>

      <div className={styles.body}>
        {orgId && (
          <nav className={styles.sidebar} aria-label="Primary">
            {navItems.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`${styles.sidebarLink} ${isActive(href) ? styles.sidebarLinkActive : ""}`}
                aria-current={isActive(href) ? "page" : undefined}
              >
                <Icon />
                {label}
              </Link>
            ))}
            <div className={styles.sidebarSpacer} />
            <SignOutButton variant="ghost" />
          </nav>
        )}

        <main className={styles.main}>{children}</main>
      </div>

      {orgId && (
        <nav className={styles.bottomNav} aria-label="Primary">
          {navItems.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`${styles.navLink} ${isActive(href) ? styles.navLinkActive : ""}`}
              aria-current={isActive(href) ? "page" : undefined}
            >
              <Icon />
              {label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
