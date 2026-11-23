import type { ReactNode } from "react";
import styles from "./frame.module.css";

// A small component with a CSS module. Two pages render it, and so does the
// drawer that pages load with next/dynamic.
export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.frame} data-marker="marker-frame">
      {children}
    </div>
  );
}
