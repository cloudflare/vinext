/**
 * Test fixture: the throwing layout's own boundary. It wraps the layout's
 * children, so it cannot catch the layout's notFound().
 */
export default function NotFound() {
  return <p id="not-found-layout-segment-id-nf">Not Found (id boundary)</p>;
}
