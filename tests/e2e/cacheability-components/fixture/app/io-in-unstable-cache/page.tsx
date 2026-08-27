// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io, unstable_cache } from "next/cache";

const readCachedValue = unstable_cache(async () => {
  await io();
  return "io resolved inside unstable cache";
}, ["cacheability-io-inside-unstable-cache"]);

async function establishRouteCacheLife() {
  "use cache";
  return null;
}

export default async function IoInUnstableCachePage() {
  // Keep the io() call exclusively inside unstable_cache while making the
  // surrounding route otherwise eligible for a completed public policy.
  await establishRouteCacheLife();
  return <p>{await readCachedValue()}</p>;
}
