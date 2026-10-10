import { connection } from "next/server";

export default async function PanelSubBPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <aside id="children-slot-default-loading-panel-b">Panel for b</aside>;
}
