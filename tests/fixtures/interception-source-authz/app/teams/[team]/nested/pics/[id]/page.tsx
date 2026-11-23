export default async function TeamNestedPicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Team nested pic {id}</p>;
}
