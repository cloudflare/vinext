import { ORDER_ROWS_1 } from "./order-rows-1";
import { ORDER_ROWS_2 } from "./order-rows-2";
import { ORDER_ROWS_3 } from "./order-rows-3";
import { Label } from "./label";

const ROWS = [...ORDER_ROWS_1, ...ORDER_ROWS_2, ...ORDER_ROWS_3];

// The order list and its rows: over 20 kB together, in files that are each
// under it. `/orders` and `/overview` render it.
export function OrderList() {
  return (
    <section data-marker="marker-order-list">
      <Label>{ROWS[0]!.label}</Label>
      <p>{ROWS.length}</p>
    </section>
  );
}
