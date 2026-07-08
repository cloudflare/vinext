import Link from "next/link";
import { FeedState } from "./feed-state";

type FeedSearchParams = {
  tab?: string | string[];
};

function getTab(searchParams: FeedSearchParams | undefined): string {
  const tab = searchParams?.tab;
  if (Array.isArray(tab)) return tab[0] ?? "default";
  return tab ?? "default";
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams?: FeedSearchParams | Promise<FeedSearchParams>;
}) {
  await fetch("data:text/plain,feed-source", { cache: "no-store" });
  const resolvedSearchParams = await searchParams;

  return (
    <div data-testid="feed-page">
      <h1>Photo Feed</h1>
      <FeedState initialTab={getTab(resolvedSearchParams)} />
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
          <Link href="/photos/42" id="feed-photo-42-link" prefetch={true}>
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
