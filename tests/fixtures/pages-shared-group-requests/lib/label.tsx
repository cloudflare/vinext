import type { ReactNode } from "react";
import styles from "./label.module.css";

// A small component with a CSS module that both lists use.
export function Label({ children }: { children: ReactNode }) {
  return (
    <span className={styles.label} data-marker="marker-label">
      {children}
    </span>
  );
}
