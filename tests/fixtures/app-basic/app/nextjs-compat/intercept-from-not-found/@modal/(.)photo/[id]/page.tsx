export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-from-not-found-modal">Photo modal: {id}</p>;
}
