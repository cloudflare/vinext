/**
 * Test fixture: layout rendering a parallel slot that only has default.tsx,
 * which calls notFound(). Next.js renders an unmatched slot as a
 * `__DEFAULT__` segment without the slot directory's files, so neither
 * @panel/not-found.tsx nor this segment's not-found.tsx catches it: the
 * not-found above this layout does.
 */
export default function Layout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <section id="slot-own-panel-layout">
      {children}
      <div id="slot-own-panel-slot">{panel}</div>
    </section>
  );
}
