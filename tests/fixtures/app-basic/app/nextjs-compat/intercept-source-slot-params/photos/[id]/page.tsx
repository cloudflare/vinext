export default async function PhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-source-slot-params-photo">Photo page: {id}</p>;
}
