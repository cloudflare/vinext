export default function ShelfLayout({
  aside,
  children,
  modal,
}: {
  aside: React.ReactNode;
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {aside}
      {modal}
    </>
  );
}
