// Next.js renders the root not-found page for a slot page's notFound(), not
// this one.
export default function NotFound() {
  return <p id="slot-route-not-found">route not found</p>;
}
