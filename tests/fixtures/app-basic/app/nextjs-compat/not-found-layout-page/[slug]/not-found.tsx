/**
 * Test fixture: slug-level not-found boundary.
 * This would catch notFound() from the page, but when the layout also throws,
 * the layout's error should propagate to the parent boundary instead.
 */
export default function NotFound() {
  return <p id="not-found-layout-page-slug-nf">Not Found (layout-page slug boundary)</p>;
}
