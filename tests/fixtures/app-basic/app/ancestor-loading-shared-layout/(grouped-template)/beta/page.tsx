import { connection } from "next/server";

export default async function BetaPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-beta">Beta page</h1>;
}
