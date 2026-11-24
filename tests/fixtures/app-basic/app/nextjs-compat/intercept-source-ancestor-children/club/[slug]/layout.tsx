/**
 * Test fixture: the layout owning the modal slot. `/club/static` is a static
 * page beside it, without the slot, that links into it.
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
    <div id="intercept-ancestor-children-club-layout">
      <p>Club layout: {slug}</p>
      {children}
      {modal}
    </div>
  );
}
