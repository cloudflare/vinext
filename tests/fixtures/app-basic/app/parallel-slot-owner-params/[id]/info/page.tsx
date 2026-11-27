export default async function InfoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>info {id}</p>;
}
