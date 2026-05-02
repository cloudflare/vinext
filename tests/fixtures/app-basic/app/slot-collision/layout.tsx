export default function SlotCollisionParentLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <section data-testid="slot-collision-parent-layout">
      <div data-testid="slot-collision-parent-modal">{modal}</div>
      {children}
    </section>
  );
}
