export default function Layout({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <div id="replay-fallback-page-error-layout">
      <main>{children}</main>
      <aside>{sidebar}</aside>
    </div>
  );
}
