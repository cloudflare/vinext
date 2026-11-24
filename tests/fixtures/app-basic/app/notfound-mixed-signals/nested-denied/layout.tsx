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
    <div id="mixed-signals-nested-denied-layout">
      <main>{children}</main>
      <section>{team}</section>
      <aside>{sidebar}</aside>
    </div>
  );
}
