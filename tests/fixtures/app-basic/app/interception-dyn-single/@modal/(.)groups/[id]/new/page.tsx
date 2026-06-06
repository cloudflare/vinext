export default async function NewItemModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div id="new-modal">Modal: New item for group {id}</div>;
}
