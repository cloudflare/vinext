import type { ReactNode } from "react";
import styles from "./site-frame.module.css";

export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.frame} data-marker="marker-site-frame">
      {children}
    </div>
  );
}
