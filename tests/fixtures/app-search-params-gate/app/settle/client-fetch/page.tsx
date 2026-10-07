import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { FetchingSearchValue } from "./fetching-search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <Suspense fallback={<SearchFallback />}>
        <FetchingSearchValue />
      </Suspense>
    </main>
  );
}
