/**
 * Not-found boundary for layout-params-notfound regression fixture.
 *
 * Renders a distinct, easily-assertable element so the test can confirm
 * the not-found path was taken (rather than a crash or empty response).
 */
export default function NotFound() {
  return (
    <div id="layout-params-notfound-boundary">
      <p id="layout-params-notfound-text">not found</p>
    </div>
  );
}
