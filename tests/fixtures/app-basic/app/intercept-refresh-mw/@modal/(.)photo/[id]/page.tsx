export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="photo-modal">modal {id}</p>;
}
