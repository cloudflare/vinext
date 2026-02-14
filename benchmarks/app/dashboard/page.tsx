import { Counter } from "../_components/counter";
export const metadata = { title: "Dashboard" };
export default function DashboardPage() {
  const stats = [
    { label: "Total Users", value: "12,345" },
    { label: "Revenue", value: "$98,765" },
    { label: "Orders", value: "3,456" },
    { label: "Conversion", value: "3.2%" },
  ];
  return (
    <div>
      <h1>Dashboard Overview</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", marginBottom: "2rem" }}>
        {stats.map(s => (
          <div key={s.label} style={{ padding: "1rem", border: "1px solid #ddd", borderRadius: "8px" }}>
            <div style={{ fontSize: "0.8rem", color: "#666" }}>{s.label}</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{s.value}</div>
          </div>
        ))}
      </div>
      <Counter label="Page Views" />
    </div>
  );
}

