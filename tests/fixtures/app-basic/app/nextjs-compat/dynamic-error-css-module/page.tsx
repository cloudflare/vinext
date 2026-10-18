import styles from "./page.module.css";

export const dynamic = "error";

export default function Page() {
  return (
    <main data-testid="dynamic-error-css-module" className={styles.main}>
      dynamic = &quot;error&quot; with a CSS module
    </main>
  );
}
