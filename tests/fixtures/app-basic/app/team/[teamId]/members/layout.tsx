export default function MembersLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <div data-testid="members-layout">
      {children}
      {modal && <div data-testid="members-modal-slot">{modal}</div>}
    </div>
  );
}
