// The panel slot alone matches sub/b, so the children slot renders its default
// there, and the loading here wraps the children slot's segment.
export default function ChildrenSlotDefaultLoadingLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <section>
      {children}
      {panel}
    </section>
  );
}
