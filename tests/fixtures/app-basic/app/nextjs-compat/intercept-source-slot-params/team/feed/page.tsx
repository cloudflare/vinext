import Link from "next/link";

export default function FeedPage() {
  return (
    <div id="intercept-source-slot-params-feed">
      <p id="intercept-source-slot-params-feed-rendered">{Date.now()}</p>
      <Link href="/nextjs-compat/intercept-source-slot-params/photos/1">Photo 1</Link>
    </div>
  );
}
