export default async function ShotModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-metadata-files-shot-modal">Shot modal: {id}</p>;
}
