/**
 * Test fixture: routes whose page calls forbidden() or unauthorized() while a
 * parallel slot beside it calls notFound(). Each signal is caught by its own
 * boundary, so the document renders both beside the route's other slot.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="mixed-signals-layout">{children}</div>;
}
