/**
 * Test fixture: the layout owning the modal slot. A URL beneath it that
 * matches no route renders the root not-found page without this layout, so a
 * navigation from that page is not intercepted.
 */
export default function InterceptFromNotFoundLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="intercept-from-not-found-layout">
      {children}
      {modal}
    </div>
  );
}
