// The group only organizes the slot's files; it has no layout.
export default async function AlbumPicModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>ALBUMS-PICS-MODAL {id}</p>;
}
