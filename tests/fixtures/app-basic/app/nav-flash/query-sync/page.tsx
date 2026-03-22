import { Suspense } from "react";
import { unstable_noStore as noStore } from "next/cache";
import { FilterControls } from "./FilterControls";

type SearchParams = Promise<{
  filter?: string;
}>;

async function SlowList({ filter }: { filter: string }) {
  noStore();
  await new Promise((resolve) => setTimeout(resolve, 700));

  const rows =
    filter === "beta" ? ["Beta 1", "Beta 2", "Beta 3"] : ["Alpha 1", "Alpha 2", "Alpha 3"];

  return (
    <>
      <style>{`
        @keyframes queryFadeIn {
          from {
            opacity: 0;
          }

          to {
            opacity: 1;
          }
        }
      `}</style>
      <ul id="query-filter-list">
        {rows.map((row, index) => (
          <li
            key={row}
            id={index === 0 ? "query-filter-first-row" : undefined}
            style={{ animation: "queryFadeIn 0.25s ease both" }}
          >
            {row}
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function QuerySyncPage({ searchParams }: { searchParams: SearchParams }) {
  const filter = (await searchParams).filter ?? "alpha";

  return (
    <main>
      <h1 id="query-filter-title">Server filter: {filter}</h1>
      <FilterControls />
      <Suspense fallback={<p id="query-filter-loading">Loading...</p>}>
        <SlowList filter={filter} />
      </Suspense>
    </main>
  );
}
