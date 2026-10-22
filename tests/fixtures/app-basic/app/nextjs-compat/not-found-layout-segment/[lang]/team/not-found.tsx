/**
 * Test fixture: the team segment's boundary. It is the route's deepest, so it
 * would catch the page's notFound(), but it wraps only the segment's
 * `children`, not the @members slot.
 */
export default function NotFound() {
  return <p id="not-found-layout-segment-team-nf">Not Found (team boundary)</p>;
}
