export default async function TeamPicModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>TEAM-PICS-MODAL {id}</p>;
}
