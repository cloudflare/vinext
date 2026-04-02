import { Suspense } from "react";
import { FilterLinks } from "./FilterLinks";

async function SlowContent({ filter }: { filter: string }) {
  await new Promise((r) => setTimeout(r, 200));
  const items = filter
    ? [{ id: 1, name: `Filtered: ${filter}` }]
    : [
        { id: 1, name: "Item A" },
        { id: 2, name: "Item B" },
        { id: 3, name: "Item C" },
      ];
  return (
    <ul id="item-list">
      {items.map((i) => (
        <li key={i.id}>{i.name}</li>
      ))}
    </ul>
  );
}

export default async function LinkSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "" } = await searchParams;
  return (
    <div>
      <h1 id="page-title">{filter ? `Filtered: ${filter}` : "All Items"}</h1>
      <FilterLinks />
      <Suspense fallback={<div id="loading">Loading...</div>}>
        <SlowContent filter={filter} />
      </Suspense>
    </div>
  );
}
