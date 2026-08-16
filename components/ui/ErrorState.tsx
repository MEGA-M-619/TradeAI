import styles from "./ErrorState.module.css";
import { Button } from "./Button";

/**
 * Used both as an inline form-submission error banner and, with
 * `variant="page"`, as a full section-level error (e.g. a failed data
 * load) with an optional retry action.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  variant = "inline",
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  variant?: "inline" | "page";
}) {
  const classes = [styles.banner, variant === "page" ? styles.page : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role="alert">
      <svg
        className={styles.icon}
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 6v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="10" cy="13.5" r="1" fill="currentColor" />
      </svg>
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {description && <p className={styles.description}>{description}</p>}
        {onRetry && (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
