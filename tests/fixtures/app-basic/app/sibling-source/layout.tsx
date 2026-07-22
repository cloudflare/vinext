export default function SiblingSourceLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <div data-testid="sibling-source-layout">
      {children}
      {modal && <div data-testid="sibling-modal-slot">{modal}</div>}
    </div>
  );
}
