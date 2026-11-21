import Link from "next/link";

// The header and tab strip live in the page itself, below the route's
// loading boundary. A search-only navigation keeps them mounted in Next.js
// until the new page commits.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab = "a" } = await searchParams;
  return (
    <main>
      <h1 id="item-header">Item header</h1>
      <nav>
        <Link id="tab-a" href="/search-tab-loading?tab=a">
          Tab a
        </Link>{" "}
        <Link id="tab-b" href="/search-tab-loading?tab=b">
          Tab b
        </Link>
      </nav>
      <p id="tab-body">tab {tab}</p>
    </main>
  );
}
