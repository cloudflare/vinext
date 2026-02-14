export default function FeedLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <div data-testid="feed-layout">
      {children}
      {modal && <div data-testid="modal-slot">{modal}</div>}
    </div>
  );
}
