/**
 * Test fixture: the throwing layout's own boundary. It wraps the layout's
 * children, so it cannot catch the layout's notFound(), and the [lang]
 * boundary that does is not the one the page's notFound() would use.
 */
export default function NotFound() {
  return <p id="not-found-layout-segment-slow-nf">Not Found (slow id boundary)</p>;
}
