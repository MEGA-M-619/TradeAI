import Link from "next/link";
import styles from "./PageHeader.module.css";

export function PageHeader({
  title,
  subtitle,
  backHref,
  backLabel = "Back",
  meta,
  actions,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  /** Badges/status shown alongside the title, e.g. a job's StatusBadge. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className={styles.header}>
      {backHref && (
        <div className={styles.backRow}>
          <Link href={backHref} className={styles.backLink}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 12L6 8l4-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {backLabel}
          </Link>
        </div>
      )}
      <div className={styles.titleRow}>
        <div className={styles.titleGroup}>
          <div className={styles.metaRow}>
            <h1 className={styles.title}>{title}</h1>
            {meta}
          </div>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  );
}
