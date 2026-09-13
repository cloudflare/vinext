import { unstable_cache } from "next/cache";
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
  return <p>{await readSharedValue()}</p>;
}
