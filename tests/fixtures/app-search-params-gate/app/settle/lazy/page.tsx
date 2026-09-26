import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { LazySearchValue } from "./lazy-search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <Suspense fallback={<SearchFallback />}>
        <LazySearchValue />
      </Suspense>
    </main>
  );
}
