export default async function ShelfItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Shelf item {id}</p>;
}
