export default function SlotCollisionChildLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div data-testid="slot-collision-child-layout">
      <div data-testid="slot-collision-child-modal">{modal}</div>
      {children}
    </div>
  );
}
