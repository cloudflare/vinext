/**
 * Test fixture: a layout owning the modal slot, whose page sits in the
 * `(children)` route group below it. `/club/static` is a static page in a
 * sibling route group, outside this layout, that links into it.
 */
export default async function ClubLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div id="intercept-grouped-children-layout">
      <p>Club layout: {slug}</p>
      {children}
      {modal}
    </div>
  );
}
