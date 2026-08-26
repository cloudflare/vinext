import { unstable_cache } from "next/cache";
import { recordPrivateExecution, waitForPrivateFillRelease } from "./state";

async function readPrivateValue() {
  "use cache: private";
  return `private-execution-${recordPrivateExecution()}`;
}

const readSharedValue = unstable_cache(async () => {
  await waitForPrivateFillRelease();
  try {
    return await readPrivateValue();
  } catch {
    // This catch is deliberately inside the shared callback. Next.js records
    // framework-invalid cache nesting outside user catch boundaries, so the
    // fallback must neither complete the request nor enter the shared cache.
    return "caught-inside-unstable-cache";
  }
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
