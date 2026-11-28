import { StockList } from "../../lib/tables/stock-list";
import { PriceList } from "../../lib/tables/price-list";

export default function TablesBoth() {
  return (
    <main data-page="tables/both">
      <StockList />
      <PriceList />
    </main>
  );
}
