import { Timer } from "../_components/timer";
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "200px 1fr" }}>
      <aside style={{ padding: "1rem", borderRight: "1px solid #eee" }}>
        <h3>Dashboard</h3>
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <a href="/dashboard">Overview</a>
          <a href="/dashboard/analytics">Analytics</a>
          <a href="/dashboard/users">Users</a>
          <a href="/dashboard/settings">Settings</a>
        </nav>
        <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#666" }}><Timer /></div>
      </aside>
      <div style={{ padding: "1rem" }}>{children}</div>
    </div>
  );
}

