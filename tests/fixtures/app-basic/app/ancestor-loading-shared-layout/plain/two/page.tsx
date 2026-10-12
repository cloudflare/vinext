import { connection } from "next/server";

export default async function PlainTwoPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-two">Plain two page</h1>;
}
