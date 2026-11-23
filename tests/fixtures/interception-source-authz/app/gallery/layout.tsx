// The gallery's pics render beneath this layout too, so their own request
// renders it for any viewer.
export default function GalleryLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main>
      <p>GALLERY-LAYOUT</p>
      {children}
      {modal}
    </main>
  );
}
