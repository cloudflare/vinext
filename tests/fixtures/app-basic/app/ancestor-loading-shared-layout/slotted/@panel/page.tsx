import { connection } from "next/server";

export default async function PanelSlot() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return <aside id="ancestor-shared-layout-panel">Panel slot</aside>;
}
