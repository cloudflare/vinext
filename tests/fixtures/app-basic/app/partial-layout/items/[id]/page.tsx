export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1 data-testid="partial-layout-page">Item {id}</h1>;
}
