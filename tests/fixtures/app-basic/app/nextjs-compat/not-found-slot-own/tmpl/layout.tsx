/**
 * Test fixture: this segment's template calls notFound(), and so does the
 * @members slot page beside it, which has its own not-found. Next.js catches
 * the template's notFound() above this layout, so the not-found above it
 * renders, without this layout or the slot.
 */
export default function Layout({
  children,
  members,
}: {
  children: React.ReactNode;
  members: React.ReactNode;
}) {
  return (
    <section id="slot-own-tmpl-layout">
      {children}
      <div id="slot-own-tmpl-slot">{members}</div>
    </section>
  );
}
