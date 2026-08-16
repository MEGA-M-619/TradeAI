import styles from "./Badge.module.css";

export type BadgeVariant = "neutral" | "info" | "warning" | "success" | "danger";

export function Badge({
  variant = "neutral",
  dot = true,
  children,
}: {
  variant?: BadgeVariant;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${styles[variant]}`}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
