import { Badge } from "./badge";
import "./styles.css";

/**
 * Loads Vite's module URLs, a stylesheet, and assets referenced from CSS and
 * JS. With `CF_APP_BASIC_RUN_WORKER_FIRST`, these requests match
 * `runWorkerFirst` in dev and must still be served by Vite (#4005).
 */
export default function DevModuleUrlsPage() {
  return (
    <main>
      <h1 className="dev-module-urls-title">Dev module URLs</h1>
      <div id="css-badge" className="dev-module-urls-badge" />
      <Badge />
    </main>
  );
}
