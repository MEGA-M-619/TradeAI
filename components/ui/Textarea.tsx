import { forwardRef } from "react";
import styles from "./FieldControl.module.css";

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid, className, ...props }, ref) {
    const classes = [
      styles.control,
      invalid ? styles.invalid : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <textarea
        ref={ref}
        className={classes}
        aria-invalid={invalid || undefined}
        rows={4}
        {...props}
      />
    );
  },
);
