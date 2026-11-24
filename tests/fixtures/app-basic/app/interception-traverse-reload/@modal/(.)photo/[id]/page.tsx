import Link from "next/link";

export default async function InterceptionTraverseReloadPhotoModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div id="interception-traverse-reload-photo-modal">
      <h2>Photo modal {id}</h2>
      <Link href="/interception-traverse-reload/plain" id="interception-traverse-reload-plain-link">
        Plain
      </Link>
    </div>
  );
}
