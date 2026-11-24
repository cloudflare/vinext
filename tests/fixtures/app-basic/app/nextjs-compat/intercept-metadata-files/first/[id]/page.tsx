export default async function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-metadata-files-clip-page">Clip page: {id}</p>;
}
