import { forwardRef } from "react";
import Link from "next/link";
import styles from "./Button.module.css";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "dangerSolid"
  | "ghost";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  fullWidth?: boolean;
  loading?: boolean;
  loadingText?: string;
};

/**
 * The one Button primitive for the whole app. Variant conveys hierarchy:
 * `primary` for the single main action on a screen, `secondary` for
 * everything else, `danger`/`dangerSolid` reserved for destructive
 * actions so they're never visually confusable with `primary`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      fullWidth,
      loading,
      loadingText,
      disabled,
      className,
      children,
      ...props
    },
    ref,
  ) {
    const classes = [
      styles.button,
      styles[variant],
      size === "sm" ? styles.sizeSm : null,
      fullWidth ? styles.fullWidth : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (loadingText ?? children) : children}
      </button>
    );
  },
);

type LinkButtonProps = {
  href: string;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  fullWidth?: boolean;
  className?: string;
  children: React.ReactNode;
};

/** Button-styled navigation link -- for when the action is "go to a
 * page," not "run a handler." Kept as a separate component rather than
 * a polymorphic Button since a <button> can't validly wrap or be wrapped
 * by an <a>. */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  fullWidth,
  className,
  children,
}: LinkButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    size === "sm" ? styles.sizeSm : null,
    fullWidth ? styles.fullWidth : null,
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
