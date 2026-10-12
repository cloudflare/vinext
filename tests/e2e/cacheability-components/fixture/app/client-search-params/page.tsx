import { Suspense } from "react";
import { SearchParamsLink } from "./search-params-link";

async function CachedBlock() {
  "use cache";
  return <p id="cached-block">cached block</p>;
}

export default function ClientSearchParamsPage() {
  return (
    <main>
      <CachedBlock />
      <Suspense fallback={<p id="search-params-fallback">loading</p>}>
        <SearchParamsLink />
      </Suspense>
    </main>
  );
}
