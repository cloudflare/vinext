/**
 * Test fixture: layout rendering a parallel slot whose page and default call
 * notFound(). Next.js attaches not-found boundaries only to each segment's
 * `children`, so the [lang] boundary above this layout catches the slot's
 * signal, in the document and on client navigation alike.
 */
export default function Layout({
  children,
  members,
}: {
  children: React.ReactNode;
  members: React.ReactNode;
}) {
  return (
    <section id="not-found-layout-segment-team">
      {children}
      {members}
    </section>
  );
}
