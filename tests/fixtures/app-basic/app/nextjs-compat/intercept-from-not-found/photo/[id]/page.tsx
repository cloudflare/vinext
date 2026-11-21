export default async function PhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-from-not-found-photo">Photo page: {id}</p>;
}
