/**
 * Test fixture: the layout owning the modal slot beside a sidebar slot whose
 * catch-all page binds params the source route doesn't have. A photo opens in
 * the modal from the feed while the sidebar keeps what the feed rendered.
 */
export default function TeamLayout({
  children,
  modal,
  sidebar,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <div id="intercept-source-slot-params-layout">
      <aside>{sidebar}</aside>
      <main>{children}</main>
      {modal}
    </div>
  );
}
