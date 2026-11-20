export default function Layout({
  children,
  team,
  sidebar,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <div id="replay-fallback-slot-error-layout">
      <main>{children}</main>
      <section>{team}</section>
      <aside>{sidebar}</aside>
    </div>
  );
}
