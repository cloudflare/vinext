import { OrderSection1 } from "./order-section-1";
import { OrderSection2 } from "./order-section-2";
import { OrderSection3 } from "./order-section-3";
import { OrderSection4 } from "./order-section-4";
import { OrderSection5 } from "./order-section-5";
import { OrderSection6 } from "./order-section-6";

// The order list: 6 sections that are over 20 kB together.
export function OrderList() {
  return (
    <div data-marker="marker-order-list">
      <OrderSection1 />
      <OrderSection2 />
      <OrderSection3 />
      <OrderSection4 />
      <OrderSection5 />
      <OrderSection6 />
    </div>
  );
}
