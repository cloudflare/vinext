export const metadata = { title: "Users" };
export default function UsersPage() {
  const users = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, name: `User ${i + 1}`, email: `user${i + 1}@example.com`, role: i % 3 === 0 ? "Admin" : "User",
  }));
  return (
    <div>
      <h1>Users</h1>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>{users.map(u => (
          <tr key={u.id} style={{ borderBottom: "1px solid #eee" }}>
            <td style={{ padding: "0.5rem" }}>{u.id}</td><td style={{ padding: "0.5rem" }}>{u.name}</td>
            <td style={{ padding: "0.5rem" }}>{u.email}</td><td style={{ padding: "0.5rem" }}>{u.role}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

