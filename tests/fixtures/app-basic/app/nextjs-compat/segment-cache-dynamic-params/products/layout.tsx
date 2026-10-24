export const metadata = { title: "Product catalog" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section id="products-layout">
      <h1>Product catalog</h1>
      {children}
    </section>
  );
}
