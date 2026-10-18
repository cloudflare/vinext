import { unstable_cache } from "next/cache";

export function nestedUnstableCacheTag(id: string): string {
  return `unstable-cache-nested-${id}`;
}

// An untagged unstable_cache called inside a tagged one, as in Next.js's
// app-static fixture.
export function readNestedUnstableCache(id: string): Promise<{ nonce: string }> {
  const getInner = unstable_cache(
    async () => ({ nonce: Math.random().toString(36).slice(2) }),
    ["unstable-cache-nested-inner", id],
    { revalidate: 360 },
  );
  const getOuter = unstable_cache(() => getInner(), ["unstable-cache-nested-outer", id], {
    revalidate: 1000,
    tags: [nestedUnstableCacheTag(id)],
  });
  return getOuter();
}
