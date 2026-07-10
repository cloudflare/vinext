export default function InterceptionCacheSourceLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main data-testid="interception-cache-source-layout">
      {children}
      <aside data-testid="interception-cache-modal-slot">{modal}</aside>
    </main>
  );
}
