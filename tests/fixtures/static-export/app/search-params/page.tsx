import { Suspense } from "react";
import { SearchParamsValue } from "./search-params-value";

export default function SearchParamsPage() {
  return (
    <main>
      <h1>Search Params</h1>
      <Suspense fallback={<p data-testid="query-value">loading</p>}>
        <SearchParamsValue />
      </Suspense>
    </main>
  );
}
