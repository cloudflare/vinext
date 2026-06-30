import { Suspense } from "react";
import { FilterControls } from "./FilterControls";

const DEFAULT_SEARCH_DELAY_MS = 200;
const SLOW_SEARCH_DELAY_MS = 5_000;

async function SearchResults({ query, delayMs }: { query: string; delayMs: number }) {
  await new Promise((r) => setTimeout(r, delayMs));
  if (!query) {
    return <p id="search-results">Enter a search query</p>;
  }
  return <p id="search-results">Results for: {query}</p>;
}

export default async function QuerySyncPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; delay?: string }>;
}) {
  const { q = "", delay } = await searchParams;
  // The slow path must stay comfortably above the default path so navigation
  // tests can supersede a committed page while its Suspense boundary is pending.
  const delayMs = delay === "slow" ? SLOW_SEARCH_DELAY_MS : DEFAULT_SEARCH_DELAY_MS;
  return (
    <div>
      <h1 id="query-title">{q ? `Search: ${q}` : "Search"}</h1>
      <FilterControls />
      <Suspense fallback={<div id="query-loading">Searching...</div>}>
        <SearchResults query={q} delayMs={delayMs} />
      </Suspense>
    </div>
  );
}
