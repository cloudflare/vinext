export default function SlottedLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <section id="ancestor-shared-layout-slotted">
      {children}
      {panel}
    </section>
  );
}
