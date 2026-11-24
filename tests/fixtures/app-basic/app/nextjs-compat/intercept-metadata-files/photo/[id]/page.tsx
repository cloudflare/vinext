export default async function PhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-metadata-files-photo-page">Photo page: {id}</p>;
}
