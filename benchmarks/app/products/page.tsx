import Link from "next/link";
export const metadata = { title: "Products" };

const products = [
  { id: 1, name: "Product 1", price: 39.23 },
  { id: 2, name: "Product 2", price: 86.95 },
  { id: 3, name: "Product 3", price: 15.67 },
  { id: 4, name: "Product 4", price: 32.47 },
  { id: 5, name: "Product 5", price: 69.94 },
  { id: 6, name: "Product 6", price: 87.10 },
  { id: 7, name: "Product 7", price: 98.61 },
  { id: 8, name: "Product 8", price: 55.49 },
  { id: 9, name: "Product 9", price: 63.86 },
  { id: 10, name: "Product 10", price: 66.72 },
  { id: 11, name: "Product 11", price: 39.22 },
  { id: 12, name: "Product 12", price: 48.55 },
  { id: 13, name: "Product 13", price: 94.94 },
  { id: 14, name: "Product 14", price: 53.92 },
  { id: 15, name: "Product 15", price: 97.55 },
  { id: 16, name: "Product 16", price: 79.98 },
  { id: 17, name: "Product 17", price: 14.13 },
  { id: 18, name: "Product 18", price: 79.85 },
  { id: 19, name: "Product 19", price: 33.53 },
  { id: 20, name: "Product 20", price: 97.90 },
];

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

