export default function Layout({
  children,
  team,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
}) {
  return (
    <div id="replay-fallback-slot-client-throw-layout">
      <main>{children}</main>
      <section>{team}</section>
    </div>
  );
}
