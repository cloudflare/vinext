export default async function ShotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-metadata-files-shot-page">Shot page: {id}</p>;
}
