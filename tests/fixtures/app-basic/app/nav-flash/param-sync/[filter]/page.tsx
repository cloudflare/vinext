import { Suspense } from "react";
import { unstable_noStore as noStore } from "next/cache";
import { FilterControls } from "./FilterControls";

type Params = Promise<{
  filter: string;
}>;

async function SlowList({ filter }: { filter: string }) {
  noStore();
  await new Promise((resolve) => setTimeout(resolve, 700));

  const rows =
    filter === "beta" ? ["Beta 1", "Beta 2", "Beta 3"] : ["Alpha 1", "Alpha 2", "Alpha 3"];

  return (
    <ul id="param-filter-list">
      {rows.map((row, index) => (
        <li key={row} id={index === 0 ? "param-filter-first-row" : undefined}>
          {row}
        </li>
      ))}
    </ul>
  );
}

export default async function ParamSyncPage({ params }: { params: Params }) {
  const filter = (await params).filter ?? "alpha";

  return (
    <main>
      <h1 id="param-filter-title">Server param: {filter}</h1>
      <FilterControls />
      <Suspense fallback={<p id="param-filter-loading">Loading...</p>}>
        <SlowList filter={filter} />
      </Suspense>
    </main>
  );
}
