export default async function PicModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-source-group-modal">Pic modal: {id}</p>;
}
