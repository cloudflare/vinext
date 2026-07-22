import Link from "next/link";

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <div id="group-page">Group {id}</div>
      <Link href={`/interception-dyn-single/groups/${id}/new`} id="new-link">
        New Item
      </Link>
    </div>
  );
}
