import styles from "./badge.module.css";

export function Badge({ testId }: { testId: string }) {
  return (
    <span className={`pill ${styles.badge}`} data-testid={testId}>
      Badge
    </span>
  );
}
