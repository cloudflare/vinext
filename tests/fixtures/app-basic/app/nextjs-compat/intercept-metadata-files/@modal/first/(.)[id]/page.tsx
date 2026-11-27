export default async function ClipModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-metadata-files-clip-modal">Clip modal: {id}</p>;
}
