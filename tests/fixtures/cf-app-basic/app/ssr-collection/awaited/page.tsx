import { Suspense } from "react";
import { Cell, Collection } from "../collection";

export const dynamic = "force-dynamic";

const CELL_COUNT = 60;

async function AwaitedCollection() {
  // Resolves in a microtask, while React is still writing the first flush.
  await Promise.resolve();
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
      <AwaitedCollection />
    </Suspense>
  );
}
