export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1 id="page-heading">{`dynamic-layout ${id}`}</h1>;
}
