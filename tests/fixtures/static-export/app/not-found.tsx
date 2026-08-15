import { Suspense } from "react";
import { QueryValue } from "./search-params/query-value";

export default function NotFound() {
  return (
    <main>
      <h1>Static export not found</h1>
      <Suspense fallback={<p data-testid="query-value">loading</p>}>
        <QueryValue />
      </Suspense>
    </main>
  );
}
