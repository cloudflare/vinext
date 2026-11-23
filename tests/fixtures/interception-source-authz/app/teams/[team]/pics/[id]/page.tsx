export default async function TeamPicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Team pic {id}</p>;
}
