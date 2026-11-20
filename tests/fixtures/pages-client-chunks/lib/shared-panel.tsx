import type { ReactNode } from "react";
import styles from "./shared-panel.module.css";

// A small module with a small stylesheet that two pages share.
export function SharedPanel({ children }: { children: ReactNode }) {
  return <section className={styles.panel}>{children}</section>;
}
