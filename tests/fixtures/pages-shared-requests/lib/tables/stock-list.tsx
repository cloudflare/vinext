import { StockSection1 } from "./stock-section-1";
import { StockSection2 } from "./stock-section-2";
import { StockSection3 } from "./stock-section-3";
import { StockSection4 } from "./stock-section-4";
import { StockSection5 } from "./stock-section-5";
import { StockSection6 } from "./stock-section-6";

// The stock list: 6 sections that are over 20 kB together.
export function StockList() {
  return (
    <div data-marker="marker-stock-list">
      <StockSection1 />
      <StockSection2 />
      <StockSection3 />
      <StockSection4 />
      <StockSection5 />
      <StockSection6 />
    </div>
  );
}
