/**
 * Not-found page for the rsc-context-lazy-stream regression fixture.
 *
 * This component is rendered by renderHTTPAccessFallbackPage() when the
 * page.tsx calls notFound(). It is wrapped in the ancestor layout, which
 * reads headers() asynchronously.
 *
 * The data-request-id attribute on the layout's wrapper div is set from
 * headers() — if the early-clear bug is present, the layout sees null
 * context and data-request-id will be "missing". With the fix, it reflects
 * the actual x-rsc-context-test header value sent by the test.
 */
export default function NotFound() {
  return (
    <div id="rsc-context-not-found">
      <p>Not Found</p>
    </div>
  );
}
