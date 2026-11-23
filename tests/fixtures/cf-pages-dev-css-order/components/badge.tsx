import styles from "./badge.module.css";

export function Badge() {
  return (
    <span className={`pill ${styles.badge}`} data-testid="badge">
      Badge
    </span>
  );
}
