import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { DynamicSearchValue } from "./dynamic-search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <Suspense fallback={<SearchFallback />}>
        <DynamicSearchValue />
      </Suspense>
    </main>
  );
}
