import Link from "next/link";

export default async function FeedPage() {
  await fetch("data:text/plain,feed-source", { cache: "no-store" });

  return (
    <div data-testid="feed-page">
      <h1>Photo Feed</h1>
      <ul>
        <li>
          <Link href="/photos/1">Photo 1</Link>
        </li>
        <li>
          <Link href="/photos/2">Photo 2</Link>
        </li>
        <li>
          <Link href="/photos/3">Photo 3</Link>
        </li>
        <li>
          <Link href="/photos/42" id="feed-photo-42-link">
            Photo 42
          </Link>
        </li>
        <li>
          <Link href="/gallery" id="gallery-link">
            Gallery
          </Link>
        </li>
      </ul>
    </div>
  );
}
