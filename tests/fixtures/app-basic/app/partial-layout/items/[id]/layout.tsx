export default async function ItemLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section>
      <p data-testid="partial-item-layout">
        Item layout {id}: {crypto.randomUUID()}
      </p>
      {children}
    </section>
  );
}
