/**
 * Test fixture: parent-level not-found boundary.
 * Catches notFound() thrown from [slug]/layout.tsx.
 */
export default function NotFound() {
  return <p id="not-found-layout-parent">Not Found (parent boundary)</p>;
}
