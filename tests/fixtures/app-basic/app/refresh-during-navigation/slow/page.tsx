import { connection } from "next/server";

export default async function RefreshDuringNavigationSlowPage() {
  // Dynamic, so each request waits and builds never prerender it.
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return <p id="slow-page">Slow page</p>;
}
