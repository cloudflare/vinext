import { CopyLeaf, CopyLocal } from "fake-copy-barrel";
import { ConsumerCopy } from "fake-copy-consumer";
import { OrderUsed } from "fake-export-order-barrel";
import { ClientOrder } from "./client-order";

export default function OptimizeImportsResolutionPage() {
  return (
    <main>
      <OrderUsed id="server-export-order" />
      <ClientOrder />
      <CopyLocal id="app-copy-local" />
      <CopyLeaf id="app-copy-leaf" />
      <ConsumerCopy />
    </main>
  );
}
