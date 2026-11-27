/**
 * Test fixture: a layout above the modal slot's owner, outside the static
 * pages of `(other)`, with a slot whose page at `/club/[slug]` sits beneath
 * a layout of its own.
 */
export default function SharedLayout({
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
