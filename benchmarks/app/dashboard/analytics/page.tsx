export const metadata = { title: "Analytics" };

const rows = [
  { page: "/page-1", views: 9773, bounce: 73 },
  { page: "/page-2", views: 2220, bounce: 29 },
  { page: "/page-3", views: 1920, bounce: 45 },
  { page: "/page-4", views: 1722, bounce: 24 },
  { page: "/page-5", views: 1211, bounce: 75 },
  { page: "/page-6", views: 7838, bounce: 10 },
  { page: "/page-7", views: 6344, bounce: 31 },
  { page: "/page-8", views: 927, bounce: 71 },
  { page: "/page-9", views: 7591, bounce: 34 },
  { page: "/page-10", views: 3371, bounce: 20 },
];

export default function AnalyticsPage() {
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

