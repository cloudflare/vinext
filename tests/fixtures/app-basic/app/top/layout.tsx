export default function TopLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <div data-testid="top-layout">
      {children}
      {modal && <div data-testid="top-modal-slot">{modal}</div>}
    </div>
  );
}
