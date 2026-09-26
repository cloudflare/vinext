import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { LateSearchValue, RenderStarted } from "./late-search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <RenderStarted />
      <Suspense fallback={<SearchFallback />}>
        <LateSearchValue />
      </Suspense>
    </main>
  );
}
