import { Card } from "@/components/ui";
import styles from "./AuthShell.module.css";

export function AuthShell({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            T
          </span>
          TradeAI
        </div>
        <Card>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {children}
        </Card>
        {footer && <p className={styles.footer}>{footer}</p>}
      </div>
    </div>
  );
}
