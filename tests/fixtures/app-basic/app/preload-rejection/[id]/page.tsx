import { notFound } from "next/navigation";
import { cache } from "react";

// Next.js's documented "Preloading data" pattern: `preload()` starts the fetch
// without awaiting it, so for an unknown id the promise rejects while the page
// is still awaiting other work. The rejection is unhandled for a few ticks,
// then handled by the later `await`. A running server must survive it.
const getItem = cache(async (id: string) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (id !== "1") throw new Error(`item not found: ${id}`);
  return { name: "Item 1" };
});

const preload = (id: string) => {
  void getItem(id);
};

export default async function PreloadRejectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  preload(id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  let item: { name: string };
  try {
    item = await getItem(id);
  } catch {
    notFound();
  }
  return <p id="item-name">{item.name}</p>;
}
