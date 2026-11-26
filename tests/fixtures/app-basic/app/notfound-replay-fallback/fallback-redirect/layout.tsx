export default function Layout({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <div id="replay-fallback-fallback-redirect-layout">
      <main>{children}</main>
      <aside>{sidebar}</aside>
    </div>
  );
}
