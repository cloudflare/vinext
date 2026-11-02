/**
 * Test fixture: the guarded layout's own boundary. It wraps the layout's
 * children, so it cannot catch the notFound() of a component the layout renders.
 */
export default function NotFound() {
  return <p id="not-found-layout-segment-guard-nf">Not Found (guard boundary)</p>;
}
