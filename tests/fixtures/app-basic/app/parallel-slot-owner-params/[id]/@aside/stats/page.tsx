export default async function AsideStats({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>aside stats {id}</p>;
}
