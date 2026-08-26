import { unstable_cache } from "next/cache";
import { recordPrivateExecution, waitForPrivateFillRelease } from "./state";

async function readPrivateValue() {
  "use cache: private";
  return `private-execution-${recordPrivateExecution()}`;
}

const readSharedValue = unstable_cache(async () => {
  await waitForPrivateFillRelease();
  return readPrivateValue();
}, ["cacheability-use-cache-private-in-unstable-cache"]);

export default async function PrivateInUnstableCachePage() {
  try {
    return <p>{await readSharedValue()}</p>;
  } catch {
    // Next.js keeps framework-invalid dynamic usage fatal even if user code
    // catches the immediate throw. The outer request boundary must still fail.
    return <p>caught-private-in-unstable-cache</p>;
  }
}
