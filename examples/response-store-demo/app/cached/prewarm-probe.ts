import { cacheLife } from "next/cache";

export async function loadPrewarmProbe(slug: string) {
  "use cache";
  cacheLife({ revalidate: 60, expire: 300 });
  return { cacheId: crypto.randomUUID(), cachedAt: Date.now(), slug };
}
