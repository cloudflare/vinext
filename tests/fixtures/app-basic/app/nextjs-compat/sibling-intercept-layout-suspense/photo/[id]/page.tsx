export default async function Photo({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="sibling-intercept-layout-suspense-photo">Photo page: {id}</p>;
}
