export default async function AlbumPicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Album pic {id}</p>;
}
