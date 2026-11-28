import { CatalogList } from "../../lib/lists/catalog-list";
import { OrderList } from "../../lib/lists/order-list";

export default function ListsBoth() {
  return (
    <main data-page="lists/both">
      <CatalogList />
      <OrderList />
    </main>
  );
}
