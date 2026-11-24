import Link from "next/link";

export default function FeedPage() {
  return (
    <div>
      <p id="feed-page">feed</p>
      <Link href="/intercept-refresh-mw/photo/1" id="feed-photo-link">
        Photo 1
      </Link>
    </div>
  );
}
