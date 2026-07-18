export default function SlowSlotLayout({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <main>
      <section>{children}</section>
      <aside>{sidebar}</aside>
    </main>
  );
}
