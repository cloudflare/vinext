// The route's deepest not-found, so the document's head uses its metadata,
// even though the not-found above the panel layout is the one that renders.
export const metadata = { title: "Not Found (panel segment)" };

export default function NotFound() {
  return <p id="slot-own-panel-segment-nf">Not Found (panel segment)</p>;
}
