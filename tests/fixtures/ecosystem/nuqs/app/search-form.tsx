"use client";

import { useQueryState, parseAsInteger } from "nuqs";

export function SearchForm() {
  const [query, setQuery] = useQueryState("q", { defaultValue: "" });
  const [page, setPage] = useQueryState("page", parseAsInteger.withDefault(1));

  return (
    <div>
      <div>
        <label htmlFor="search">Search: </label>
        <input
          id="search"
          data-testid="search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value || null)}
          placeholder="Type a query..."
        />
      </div>
      <div>
        <p data-testid="current-query">Query: {query || "(empty)"}</p>
        <p data-testid="current-page">Page: {page}</p>
        <button
          data-testid="prev-page"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Previous
        </button>
        <button
          data-testid="next-page"
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
