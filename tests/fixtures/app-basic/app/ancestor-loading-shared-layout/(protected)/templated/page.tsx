import { connection } from "next/server";

export default async function TemplatedPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-templated">Templated page</h1>;
}
