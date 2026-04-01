import { Suspense } from "react";
import { FilterControls } from "./FilterControls";

async function FilteredContent({ filter }: { filter: string }) {
  await new Promise((r) => setTimeout(r, 150));
  return <p id="filtered-content">Showing: {filter}</p>;
}

export default async function ParamSyncPage({ params }: { params: Promise<{ filter: string }> }) {
  const { filter } = await params;
  return (
    <div>
      <h1 id="param-title">Filter: {filter}</h1>
      <FilterControls />
      <Suspense fallback={<div id="param-loading">Loading filter...</div>}>
        <FilteredContent filter={filter} />
      </Suspense>
    </div>
  );
}
