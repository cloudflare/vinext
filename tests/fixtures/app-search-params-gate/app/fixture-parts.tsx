export function SearchFallback() {
  return <span data-testid="search-fallback">fallback</span>;
}

// A new id per render, so a stored response is recognisable.
export function RenderId() {
  return <output data-testid="render-id">{crypto.randomUUID()}</output>;
}
