import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { SearchValue } from "../../search-value";
import { SlowClient } from "./slow-client";

// SlowClient sits outside any Suspense boundary, so it holds the shell.
export default function Page() {
  return (
    <main>
      <RenderId />
      <SlowClient />
      <Suspense fallback={<SearchFallback />}>
        <SearchValue />
      </Suspense>
    </main>
  );
}
