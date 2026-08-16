import styles from "./FormField.module.css";

type FormFieldProps = {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
};

/**
 * Label + control + hint/error, spaced consistently. The caller passes
 * the actual Input/Select/Textarea as `children` with a matching `id` --
 * kept explicit rather than cloning props onto children, which is easy
 * to get subtly wrong across three different control types.
 */
export function FormField({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
}: FormFieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={styles.hint}>{hint}</p>
      ) : null}
    </div>
  );
}
