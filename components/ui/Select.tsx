import { forwardRef } from "react";
import fieldStyles from "./FieldControl.module.css";
import styles from "./Select.module.css";

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ invalid, className, children, ...props }, ref) {
    const classes = [
      fieldStyles.control,
      styles.select,
      invalid ? fieldStyles.invalid : null,
      className,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className={styles.wrapper}>
        <select
          ref={ref}
          className={classes}
          aria-invalid={invalid || undefined}
          {...props}
        >
          {children}
        </select>
        <svg
          className={styles.chevron}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  },
);
