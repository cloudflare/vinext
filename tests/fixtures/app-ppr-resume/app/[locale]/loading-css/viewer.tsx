"use client";

import styles from "./viewer.module.css";

export function Viewer({ name }: { name: string }) {
  return (
    <p id="loading-css-viewer" className={styles.viewer}>
      viewer for {name}
    </p>
  );
}
