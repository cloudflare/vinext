import Link from "next/link";
import { Suspense } from "react";
import { FilterToggle } from "./FilterToggle";

const ALL_ITEMS = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  text: `Item ${String.fromCharCode(65 + i)}`, // Item A … Item T
}));

async function ItemList({ filter }: { filter: string }) {
  // Artificial delay: long enough for Playwright to catch intermediate state.
  await new Promise((r) => setTimeout(r, 400));
  const items = filter ? [{ id: 1, text: `Filtered: ${filter}` }] : ALL_ITEMS;
  return (
    <ul id="item-list">
      {items.map((i) => (
        <li key={i.id} style={{ padding: "1rem 0", borderBottom: "1px solid #eee" }}>
          <Link href={`/suspense-nav-test/item/${i.id}`}>{i.text}</Link>
        </li>
      ))}
    </ul>
  );
}

export default async function SuspenseNavTestPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "" } = await searchParams;

  return (
    <div>
      {/* Heading is OUTSIDE the Suspense boundary.
          With flushSync, it updates before the list is ready — partial flash.
          With startTransition (NavigationRoot), it only updates once the list
          is also ready — both change together (issue #639). */}
      <h1 id="page-heading">{filter ? `Filtered: ${filter}` : "All Items"}</h1>
      <FilterToggle current={filter} />
      <Suspense fallback={<div id="list-loading">Loading items...</div>}>
        <ItemList filter={filter} />
      </Suspense>
    </div>
  );
}
