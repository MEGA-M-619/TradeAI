import styles from "./LoadingState.module.css";

/** A short list of skeleton cards -- used for list screens (jobs, customers). */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.skeletonCard} />
      ))}
    </div>
  );
}

/** A few skeleton lines -- used for detail/form screens. */
export function TextSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={styles.skeletonLine}
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}

export function Spinner() {
  return (
    <div className={styles.spinnerWrap} role="status" aria-label="Loading">
      <div className={styles.spinner} />
    </div>
  );
}
