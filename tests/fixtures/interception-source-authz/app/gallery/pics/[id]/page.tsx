export default async function GalleryPicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>Gallery pic {id}</p>;
}
