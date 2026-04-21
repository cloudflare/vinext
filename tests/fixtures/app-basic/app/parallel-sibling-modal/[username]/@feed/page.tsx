import Link from "next/link";

export default function ParallelFeedPage({ params }: { params: { username: string } }) {
  return (
    <section data-testid="parallel-feed-page">
      <h2>Feed for {params.username}</h2>
      <Link href="/parallel-sibling-modal/photo/42" id="parallel-photo-42-link">
        Photo 42
      </Link>
    </section>
  );
}
