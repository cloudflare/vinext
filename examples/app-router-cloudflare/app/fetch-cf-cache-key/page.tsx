import { headers } from "next/headers";

// Workers picks the origin from `cf.resolveOverride` without changing the URL
// or headers, so each override needs its own cached and deduped fetch. Local
// workerd ignores the override, so every fetch reaches /api/fetch-cf-origin.
async function fetchOriginId(url: string, origin: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, { ...init, cf: { resolveOverride: `${origin}.example.com` } });
  return ((await response.json()) as { id: string }).id;
}

export default async function FetchCfCacheKeyPage({
  searchParams,
}: {
  searchParams: Promise<{ origin?: string }>;
}) {
  const { origin = "a" } = await searchParams;
  const url = `http://${(await headers()).get("host")}/api/fetch-cf-origin`;

  const [cachedId, dedupedA, dedupedB, dedupedARepeat] = await Promise.all([
    fetchOriginId(url, `cached-${origin}`, { next: { revalidate: 3600 } }),
    fetchOriginId(url, "deduped-a", { cache: "no-store" }),
    fetchOriginId(url, "deduped-b", { cache: "no-store" }),
    fetchOriginId(url, "deduped-a", { cache: "no-store" }),
  ]);

  return (
    <main>
      <h1>fetch cf cache key</h1>
      <p data-testid="cached-id">{cachedId}</p>
      <p data-testid="deduped-a">{dedupedA}</p>
      <p data-testid="deduped-b">{dedupedB}</p>
      <p data-testid="deduped-a-repeat">{dedupedARepeat}</p>
    </main>
  );
}
