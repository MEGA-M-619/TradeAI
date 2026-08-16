import { forwardRef } from "react";
import styles from "./FieldControl.module.css";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...props },
  ref,
) {
  const classes = [styles.control, invalid ? styles.invalid : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <input
      ref={ref}
      className={classes}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
});
