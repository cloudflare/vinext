import { CatalogList } from "../lib/catalog-list";
import { OrderList } from "../lib/order-list";

// The one page that renders both lists.
export default function Overview() {
  return (
    <main data-page="overview">
      <CatalogList />
      <OrderList />
    </main>
  );
}
