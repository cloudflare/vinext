export default async function PicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-grouped-children-pic">Pic page: {id}</p>;
}
