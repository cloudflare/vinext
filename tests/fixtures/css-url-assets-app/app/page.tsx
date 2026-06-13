"use client";

import styles from "./page.module.css";

// Client component so its CSS module is bundled into the client build, where
// vinext's build-only CSS url() asset repair runs.
export default function Home() {
  return (
    <main data-testid="css-url-assets" className={styles.redText}>
      App CSS URL asset test
    </main>
  );
}
