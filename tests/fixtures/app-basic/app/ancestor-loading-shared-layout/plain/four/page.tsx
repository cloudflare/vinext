import { connection } from "next/server";

export default async function PlainFourPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-four">Plain four page</h1>;
}
