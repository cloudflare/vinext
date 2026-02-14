export const metadata = { title: "Analytics" };
export default function AnalyticsPage() {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    page: `/page-${i + 1}`, views: Math.floor(Math.random() * 10000), bounce: Math.floor(Math.random() * 100),
  }));
  return (
    <div>
      <h1>Analytics</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>Page</th><th>Views</th><th>Bounce Rate</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.page} style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "0.5rem" }}>{r.page}</td>
            <td style={{ padding: "0.5rem" }}>{r.views.toLocaleString()}</td>
            <td style={{ padding: "0.5rem" }}>{r.bounce}%</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

