import { getPrisma } from "@/lib/db";

export default async function Home() {
  const prisma = getPrisma();
  const items = await prisma.item.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <main>
      <h1>Items ({items.length})</h1>
      <form action="/api/items" method="POST">
        <input name="title" placeholder="New item..." required style={{ padding: 8, marginRight: 8 }} />
        <button type="submit" style={{ padding: "8px 16px" }}>Add</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {items.map((item) => (
          <li key={item.id} style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
            <span style={{ textDecoration: item.completed ? "line-through" : "none" }}>
              {item.title}
            </span>
            <span style={{ color: "#999", fontSize: 12, marginLeft: 8 }}>
              {item.createdAt.toLocaleDateString()}
            </span>
          </li>
        ))}
        {items.length === 0 && <li style={{ color: "#999" }}>No items yet. Add one above.</li>}
      </ul>
    </main>
  );
}
