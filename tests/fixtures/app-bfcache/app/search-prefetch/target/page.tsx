import { Suspense } from "react";

async function Query({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <p id="query">Query: {q}</p>;
}

export default function SearchPrefetchTarget({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  return (
    <main>
      <p id="route-content">search target static part</p>
      <Suspense fallback={<p id="query-loading">Loading query…</p>}>
        <Query searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
