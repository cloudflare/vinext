/**
 * Test fixture: the layout owning the modal slot, whose intercepting page
 * reads the `slug` above its marker.
 */
export default function ClubLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
