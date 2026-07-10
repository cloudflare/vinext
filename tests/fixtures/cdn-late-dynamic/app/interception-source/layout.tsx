export default function InterceptionSourceLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main>
      {children}
      <aside id="interception-modal-slot">{modal}</aside>
    </main>
  );
}
