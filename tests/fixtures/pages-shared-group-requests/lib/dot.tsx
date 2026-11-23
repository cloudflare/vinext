import styles from "./dot.module.css";

// A small component with a CSS module that the catalog list and the about
// page use.
export function Dot() {
  return <span className={styles.dot} data-marker="marker-dot" />;
}
