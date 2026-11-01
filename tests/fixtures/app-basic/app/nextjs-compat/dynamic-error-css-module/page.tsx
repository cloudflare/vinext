import styles from "./page.module.css";
import { SearchParamsHolder } from "./search-params-holder";

export const dynamic = "error";

export default function Page({ searchParams }: { searchParams: Promise<unknown> }) {
  return (
    <main data-testid="dynamic-error-css-module" className={styles.main}>
      dynamic = &quot;error&quot; with a CSS module
      <SearchParamsHolder searchParams={searchParams} />
    </main>
  );
}
