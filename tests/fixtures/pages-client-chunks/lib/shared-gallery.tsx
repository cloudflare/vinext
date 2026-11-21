import type { ReactNode } from "react";
import styles from "./shared-gallery.module.css";
import gridStyles from "./shared-gallery-grid.module.css";

// A small module that two pages share, with two stylesheets that together
// hold over 20 kB of CSS.
export function SharedGallery({ children }: { children: ReactNode }) {
  return (
    <div className={styles["gallery-item-0"]}>
      <div className={gridStyles["grid-item-0"]}>{children}</div>
    </div>
  );
}
