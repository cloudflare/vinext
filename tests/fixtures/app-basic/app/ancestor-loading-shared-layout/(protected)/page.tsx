import { connection } from "next/server";

export default async function OverviewPage() {
  await connection();

  return <h1 id="ancestor-shared-layout-overview">Overview page</h1>;
}
