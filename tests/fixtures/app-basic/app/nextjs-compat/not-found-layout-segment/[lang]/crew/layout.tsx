/**
 * Test fixture: layout rendering a parallel slot whose own layout calls
 * notFound(). Like the slot's page, it is caught by the [lang] boundary above
 * this layout, not by crew/not-found.tsx or the slot's own not-found.tsx.
 */
export default function Layout({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles: React.ReactNode;
}) {
  return (
    <section id="not-found-layout-segment-crew">
      {children}
      {roles}
    </section>
  );
}
