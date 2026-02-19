/**
 * Test fixture: slug-level not-found boundary.
 * This should catch notFound() from the page, NOT from the layout.
 * Layout errors propagate to the parent (not-found-layout/not-found.tsx).
 */
export default function NotFound() {
  return <p id="not-found-layout-slug">Not Found (slug boundary)</p>;
}
