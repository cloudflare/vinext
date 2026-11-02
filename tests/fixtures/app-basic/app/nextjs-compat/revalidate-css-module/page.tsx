import styles from "./page.module.css";

// Importing CSS makes @vitejs/plugin-rsc wrap this export, and the wrapper
// renders it as an element with the page props. The page never reads
// searchParams, so it must stay cacheable.
export const revalidate = 60;

export default function Page() {
  return (
    <main data-testid="revalidate-css-module" className={styles.main}>
      revalidate with a CSS module
    </main>
  );
}
