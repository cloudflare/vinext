// The route's deepest not-found, so Next.js's error shell head uses its
// metadata, but the browser then renders the route's own head, so users never
// see this title.
export const metadata = { title: "Not Found (panel segment)" };

export default function NotFound() {
  return <p id="slot-own-panel-segment-nf">Not Found (panel segment)</p>;
}
