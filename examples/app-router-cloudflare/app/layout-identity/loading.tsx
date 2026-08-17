// A loading boundary above the shared `[slug]` layout. Its presence is what
// turns a same-layout navigation into a full teardown of everything below it.
export default function Loading() {
  return <p data-testid="loading-fallback">Loading…</p>;
}
