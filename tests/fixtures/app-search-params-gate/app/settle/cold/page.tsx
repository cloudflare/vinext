import { Suspense } from "react";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { ColdSearchValue } from "./cold-search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <Suspense fallback={<SearchFallback />}>
        <ColdSearchValue />
      </Suspense>
    </main>
  );
}
