export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-source-not-found-modal">Photo modal: {id}</p>;
}
