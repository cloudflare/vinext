import { headers } from "next/headers";

// Stands in for an awaited session check: reads request data, then waits.
export async function sleep(ms: number) {
  await headers();
  await new Promise((resolve) => setTimeout(resolve, ms));
}
