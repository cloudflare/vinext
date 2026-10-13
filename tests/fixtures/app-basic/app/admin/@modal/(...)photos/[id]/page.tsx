export default async function AdminPhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div data-testid="admin-photo-modal">Admin photo modal {id}</div>;
}
