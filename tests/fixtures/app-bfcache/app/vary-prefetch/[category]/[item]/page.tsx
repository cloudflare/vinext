import { connection } from "next/server";
import { Suspense } from "react";

type Params = Promise<{ category: string; item: string }>;

export function generateStaticParams() {
  return [{ category: "shoes", item: "a" }];
}

async function Item({ params }: { params: Params }) {
  // Read at request time only, so the static shell doesn't vary on `item`.
  await connection();
  const { item } = await params;
  return <p id="item">Item: {item}</p>;
}

export default async function VaryPrefetchItem({ params }: { params: Params }) {
  const { category } = await params;
  return (
    <main>
      <p id="category">Category: {category}</p>
      <Suspense fallback={<p id="item-loading">Loading item…</p>}>
        <Item params={params} />
      </Suspense>
    </main>
  );
}
