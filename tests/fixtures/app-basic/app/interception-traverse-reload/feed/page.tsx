import Link from "next/link";

export default async function InterceptionTraverseReloadFeedPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return (
    <div id="interception-traverse-reload-feed">
      <h1>Feed</h1>
      <p id="interception-traverse-reload-feed-tab">{tab ?? "none"}</p>
      <Link
        href="/interception-traverse-reload/photo/1"
        id="interception-traverse-reload-photo-link"
      >
        Photo 1
      </Link>
    </div>
  );
}
