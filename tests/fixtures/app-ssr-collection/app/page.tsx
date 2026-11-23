import { Cell, Collection } from "./collection";

export const dynamic = "force-dynamic";

const CELL_COUNT = 60;

export default function Page() {
  const cells = Array.from({ length: CELL_COUNT }, (_, i) => `cell-${i}-${"x".repeat(100)}`);
  return (
    <Collection>
      {cells.map((text) => (
        <Cell key={text} text={text} />
      ))}
    </Collection>
  );
}
