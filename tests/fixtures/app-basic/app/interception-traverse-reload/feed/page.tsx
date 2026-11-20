import Link from "next/link";

export default function InterceptionTraverseReloadFeedPage() {
  return (
    <div id="interception-traverse-reload-feed">
      <h1>Feed</h1>
      <Link
        href="/interception-traverse-reload/photo/1"
        id="interception-traverse-reload-photo-link"
      >
        Photo 1
      </Link>
    </div>
  );
}
