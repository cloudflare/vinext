export default async function NewItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div id="new-page">New item for group {id}</div>;
}
