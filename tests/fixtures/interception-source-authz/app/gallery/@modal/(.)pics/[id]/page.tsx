export default async function GalleryPicModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>GALLERY-PICS-MODAL {id}</p>;
}
