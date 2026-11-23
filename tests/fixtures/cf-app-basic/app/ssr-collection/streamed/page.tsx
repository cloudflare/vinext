import { Suspense } from "react";
import { Cell, Collection } from "../collection";

export const dynamic = "force-dynamic";

const CELL_COUNT = 60;

async function StreamedCollection() {
  // Resolves in a later task, after the shell, so React streams the collection
  // into its boundary in a later flush.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cells = Array.from({ length: CELL_COUNT }, (_, i) => `cell-${i}-${"x".repeat(100)}`);
  return (
    <Collection>
      {cells.map((text) => (
        <Cell key={text} text={text} />
      ))}
    </Collection>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading</p>}>
      <StreamedCollection />
    </Suspense>
  );
}
