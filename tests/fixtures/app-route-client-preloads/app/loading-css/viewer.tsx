"use client";

import styles from "./viewer.module.css";

export function Viewer() {
  return (
    <p className={styles.viewer} data-testid="loading-css-viewer">
      Viewer
    </p>
  );
}
