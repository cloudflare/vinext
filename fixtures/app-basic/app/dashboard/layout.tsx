export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div id="dashboard-layout">
      <nav>
        <span>Dashboard Nav</span>
      </nav>
      <section>{children}</section>
    </div>
  );
}
