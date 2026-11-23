/**
 * Test fixture: routes with parallel slots whose document renders again with
 * the boundary that catches a page's or a slot's notFound(), beside a slot
 * that fails to render, or with a not-found file that redirects or throws.
 * A signal there leaves the notFound() to its usual fallback document; a
 * redirect or an error answers with the 404 error shell.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="replay-fallback-layout">{children}</div>;
}
