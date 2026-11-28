import { PriceSection1 } from "./price-section-1";
import { PriceSection2 } from "./price-section-2";
import { PriceSection3 } from "./price-section-3";
import { PriceSection4 } from "./price-section-4";
import { PriceSection5 } from "./price-section-5";
import { PriceSection6 } from "./price-section-6";

// The price list: 6 sections that are over 20 kB together.
export function PriceList() {
  return (
    <div data-marker="marker-price-list">
      <PriceSection1 />
      <PriceSection2 />
      <PriceSection3 />
      <PriceSection4 />
      <PriceSection5 />
      <PriceSection6 />
    </div>
  );
}
