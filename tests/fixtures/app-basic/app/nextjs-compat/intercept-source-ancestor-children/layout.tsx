/**
 * Test fixture: a layout whose `@x` slot has a URL subroute, so the routes
 * below it hold a children slot of this layout, above the modal slot's owner.
 */
export default function AncestorChildrenLayout({
  children,
  x,
}: {
  children: React.ReactNode;
  x: React.ReactNode;
}) {
  return (
    <>
      {children}
      {x}
    </>
  );
}
