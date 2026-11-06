import { unstable_cache } from "next/cache";
import { headers } from "next/headers";
import { recordPrivateExecution } from "./state";

async function readPrivateValue() {
  "use cache: private";
  return `private-execution-${recordPrivateExecution()}`;
}

const readSharedValue = unstable_cache(
  async () => readPrivateValue(),
  ["cacheability-use-cache-private-in-unstable-cache"],
);

export default async function PrivateInUnstableCachePage() {
  // Keeps the page out of the prerender, whose build the error would fail.
  await headers();
  return <p>{await readSharedValue()}</p>;
}
