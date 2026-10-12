export default async function VaultPhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <p>VAULT-PHOTO-MODAL</p>
      <p>Vault photo {id}</p>
    </>
  );
}
