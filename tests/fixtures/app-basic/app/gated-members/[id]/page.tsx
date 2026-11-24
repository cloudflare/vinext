import Link from "next/link";

export default async function GatedMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div data-testid="gated-member-page">
      <h1>Member {id}</h1>
      <Link href="/photos/1" id="gated-member-photo-link">
        Photo 1
      </Link>
    </div>
  );
}
