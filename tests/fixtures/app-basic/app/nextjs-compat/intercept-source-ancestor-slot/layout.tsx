/**
 * Test fixture: a layout whose `@sidebar` slot has a page for `/club/static`,
 * the source of the whole intercepting route below, so both trees share it.
 */
export default function AncestorSlotLayout({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <>
      {sidebar}
      {children}
    </>
  );
}
