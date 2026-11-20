/**
 * Test fixture: routes with parallel slots whose document renders again with
 * the boundary that catches a page's or a slot's notFound(), beside a slot
 * that fails to render. The failure leaves the notFound() to its usual
 * fallback document, with its 404.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="replay-fallback-layout">{children}</div>;
}
