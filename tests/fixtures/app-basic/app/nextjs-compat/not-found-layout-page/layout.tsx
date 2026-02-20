/**
 * Test fixture: parent layout for not-found-layout-page test.
 * Has a not-found boundary to catch layout-level notFound() from [slug]/layout.tsx.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="not-found-layout-page-parent">{children}</div>;
}
