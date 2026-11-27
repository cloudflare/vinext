export default async function OwnerParamsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>page {id}</p>;
}
