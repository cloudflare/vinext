export default async function DistinctIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <span data-testid="page">id:{id}</span>;
}
