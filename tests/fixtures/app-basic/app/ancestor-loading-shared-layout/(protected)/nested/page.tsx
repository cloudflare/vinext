import { connection } from "next/server";

export default async function NestedPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-nested">Nested page</h1>;
}
