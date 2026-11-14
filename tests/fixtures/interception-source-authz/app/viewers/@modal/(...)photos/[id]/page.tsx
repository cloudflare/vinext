export default async function ViewersPhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <p>VIEWERS-PHOTO-MODAL</p>
      <p>Viewers photo {id}</p>
    </>
  );
}
