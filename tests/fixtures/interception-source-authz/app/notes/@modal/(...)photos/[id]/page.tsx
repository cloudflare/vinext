export default async function NotesPhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <p>NOTES-PHOTO-MODAL</p>
      <p>Notes photo {id}</p>
    </>
  );
}
