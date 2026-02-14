export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div style={{ padding: "0.5rem", background: "#f0f0f0", marginBottom: "1rem" }}>
        <strong>Products</strong> — <a href="/products">All</a>
      </div>
      {children}
    </div>
  );
}

