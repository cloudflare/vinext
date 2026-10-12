import { connection } from "next/server";

export default async function SlottedPage() {
  await connection();

  return <h1 id="ancestor-shared-layout-slotted-page">Slotted page</h1>;
}
