import Link from "next/link";
import styles from "./Card.module.css";

type PaddingSize = "md" | "sm" | "none";

function paddingClass(padding: PaddingSize) {
  if (padding === "sm") return styles.padSm;
  if (padding === "none") return styles.padNone;
  return null;
}

export function Card({
  children,
  padding = "md",
  className,
}: {
  children: React.ReactNode;
  padding?: PaddingSize;
  className?: string;
}) {
  const classes = [styles.card, paddingClass(padding), className]
    .filter(Boolean)
    .join(" ");
  return <div className={classes}>{children}</div>;
}

/** A whole-card tap target, e.g. a job or customer list item. */
export function CardLink({
  href,
  children,
  padding = "md",
  className,
}: {
  href: string;
  children: React.ReactNode;
  padding?: PaddingSize;
  className?: string;
}) {
  const classes = [
    styles.card,
    styles.interactive,
    paddingClass(padding),
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
