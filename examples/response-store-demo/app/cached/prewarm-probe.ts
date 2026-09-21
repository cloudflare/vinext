import { cacheLife } from "next/cache";

export async function loadPrewarmProbe(slug: string) {
  "use cache";
  cacheLife({ revalidate: 300, expire: 600 });
  return { cacheId: crypto.randomUUID(), cachedAt: Date.now(), slug };
}
