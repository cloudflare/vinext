export default async function MembersPhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <p>MEMBERS-PHOTO-MODAL</p>
      <p>Members photo {id}</p>
    </>
  );
}
