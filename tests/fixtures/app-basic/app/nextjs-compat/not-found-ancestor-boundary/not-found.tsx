/**
 * Test fixture: not-found boundary of the parent segment. It must render in
 * place of section/layout.tsx, not inside it.
 */
export default function NotFound() {
  return <p id="not-found-ancestor-boundary-nf">Not Found (ancestor boundary)</p>;
}
