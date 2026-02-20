/**
 * Test fixture: parent-level not-found boundary.
 * Catches notFound() thrown from [slug]/layout.tsx (since the layout's error
 * propagates to the parent NotFoundBoundary, not the sibling-level one).
 */
export default function NotFound() {
  return <p id="not-found-layout-page-parent-nf">Not Found (layout-page parent boundary)</p>;
}
