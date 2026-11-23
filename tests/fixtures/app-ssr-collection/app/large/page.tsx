import { Cell, Collection } from "../collection";

export const dynamic = "force-dynamic";

// Enough cells for a Flight payload of a few MB, written by React in one go.
const CELL_COUNT = 12_000;

export default function LargePage() {
  const cells = Array.from({ length: CELL_COUNT }, (_, i) => `cell-${i}-${"x".repeat(100)}`);
  return (
    <Collection>
      {cells.map((text) => (
        <Cell key={text} text={text} />
      ))}
    </Collection>
  );
}
