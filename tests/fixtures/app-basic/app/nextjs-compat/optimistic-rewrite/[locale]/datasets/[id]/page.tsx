export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return <h1 id={`dataset-${id}-page`}>Dataset page {id}</h1>;
}
