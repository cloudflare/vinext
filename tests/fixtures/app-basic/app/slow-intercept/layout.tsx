export default function SlowInterceptLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main>
      {children}
      <aside>{modal}</aside>
    </main>
  );
}
