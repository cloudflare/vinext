/**
 * Test fixture: a layout owning the modal slot without a page of its own.
 * `/club/static` is a static page in a sibling route group, outside this
 * layout, that links into it.
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
    <div id="intercept-layout-owner-layout">
      <p>Club layout: {slug}</p>
      {children}
      {modal}
    </div>
  );
}
