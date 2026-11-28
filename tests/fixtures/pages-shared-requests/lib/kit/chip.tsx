import type { ReactNode } from "react";
import styles from "./chip.module.css";

// `_app` imports from this component's barrel but does not render it. The two
// index pages do.
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className={styles.chip} data-marker="marker-chip">
      {children}
    </span>
  );
}
