export default async function TeamNestedPicModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>TEAM-NESTED-PICS-MODAL {id}</p>;
}
