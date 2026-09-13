export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Intercepted photo {id}</p>;
}
