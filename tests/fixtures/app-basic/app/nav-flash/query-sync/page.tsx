import { Suspense } from "react";
import { FilterControls } from "./FilterControls";

async function SearchResults({ query }: { query: string }) {
  await new Promise((r) => setTimeout(r, 200));
  if (!query) {
    return <p id="search-results">Enter a search query</p>;
  }
  return <p id="search-results">Results for: {query}</p>;
}

export default async function QuerySyncPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  return (
    <div>
      <h1 id="query-title">{q ? `Search: ${q}` : "Search"}</h1>
      <FilterControls />
      <Suspense fallback={<div id="query-loading">Searching...</div>}>
        <SearchResults query={q} />
      </Suspense>
    </div>
  );
}
