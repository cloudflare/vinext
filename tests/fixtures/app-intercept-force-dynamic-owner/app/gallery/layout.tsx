export default function GalleryLayout({
  aside,
  children,
}: {
  aside: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      {aside}
    </>
  );
}
