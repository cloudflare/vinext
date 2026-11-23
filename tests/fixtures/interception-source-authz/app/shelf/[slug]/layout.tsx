// Middleware blocks every shelf but its items (see middleware.ts).
export default async function ShelfLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <section>
      <p>{`SECRET-SHELF-LAYOUT:${slug}`}</p>
      {children}
    </section>
  );
}
