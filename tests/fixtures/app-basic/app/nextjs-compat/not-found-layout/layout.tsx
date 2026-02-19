/**
 * Test fixture: parent layout for not-found-layout test.
 * This layout exists so that not-found-layout/not-found.tsx has an associated
 * layout level. In Next.js, each segment with a layout gets its own
 * NotFoundBoundary wrapping the layout's children.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="not-found-layout-parent-layout">{children}</div>;
}
