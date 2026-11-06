import { cookies } from "next/headers";
import { OrderList } from "./order-list";

// Used by Playwright: app-router-prod/use-cache.spec.ts. getOrders closes over
// the session's tenant; echoLabel closes over a value any visitor chooses.
// Neither capture may be substituted by a client invoking the reference.
const ORDERS = [
  { tenantId: "acme", item: "ACME_PRIVATE_ORDER" },
  { tenantId: "globex", item: "GLOBEX_PRIVATE_ORDER" },
];

export default async function UseCacheCaptureIntegrityPage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>;
}) {
  const tenantId = (await cookies()).get("tenant")?.value ?? "anonymous";
  const { label = "" } = await searchParams;

  // A declared parameter keeps a forged first argument in the call arguments.
  async function getOrders(query?: string) {
    "use cache";
    return ORDERS.filter(
      (order) => order.tenantId === tenantId && (!query || order.item.includes(query)),
    ).map((order) => order.item);
  }

  async function echoLabel() {
    "use cache";
    return label;
  }

  return (
    <main data-testid="use-cache-capture-integrity-page">
      <p id="tenant">{tenantId}</p>
      <OrderList getOrders={getOrders} echoLabel={echoLabel} />
    </main>
  );
}
