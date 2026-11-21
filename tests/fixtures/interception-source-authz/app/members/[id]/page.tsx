export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>SECRET-MEMBER-CONTENT {id}</p>;
}
