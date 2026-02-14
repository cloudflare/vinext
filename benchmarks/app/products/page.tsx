import Link from "next/link";
export const metadata = { title: "Products" };

const products = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: Math.round(Math.random() * 10000) / 100,
}));

export default function ProductsPage() {
  return (
    <div>
      <h1>Products</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "1rem" }}>
        {products.map(p => (
          <Link key={p.id} href={`/products/${p.id}`} style={{ padding: "1rem", border: "1px solid #ddd", textDecoration: "none", color: "inherit" }}>
            <h3>{p.name}</h3>
            <p>${p.price}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

