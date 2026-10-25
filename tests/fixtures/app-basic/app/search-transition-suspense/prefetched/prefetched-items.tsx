"use client";

// Only this page renders this client module, so a click that reuses a settled
// prefetch can arrive while the module is still loading.
export function PrefetchedItems() {
  return <p data-testid="search-transition-prefetched-items">Prefetched items</p>;
}
