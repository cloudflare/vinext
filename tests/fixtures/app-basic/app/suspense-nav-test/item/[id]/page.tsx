import Link from "next/link";

// Async detail page — simulates a DB fetch that takes a moment.
// This is important for the scroll-restoration test: back-button scroll
// should only fire once the destination content is ready, not on a partial
// tree with wrong layout heights.
async function ItemDetail({ id }: { id: string }) {
  await new Promise((r) => setTimeout(r, 200));
  return (
    <div id="item-detail">
      <p>Details for item {id}</p>
      <p>This content loads asynchronously (200ms).</p>
    </div>
  );
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <h1 id="item-heading">Item {id}</h1>
      <Link href="/suspense-nav-test" id="back-link">
        ← Back to list
      </Link>
      <ItemDetail id={id} />
    </div>
  );
}
