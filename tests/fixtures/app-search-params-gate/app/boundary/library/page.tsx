import { LibrarySuspense } from "gate-suspense-lib";
import { RenderId, SearchFallback } from "../../fixture-parts";
import { SearchValue } from "../../search-value";

export default function Page() {
  return (
    <main>
      <RenderId />
      <LibrarySuspense fallback={<SearchFallback />}>
        <SearchValue />
      </LibrarySuspense>
    </main>
  );
}
