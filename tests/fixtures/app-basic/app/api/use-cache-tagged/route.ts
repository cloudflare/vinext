/**
 * Route handler whose body is produced by a `"use cache"` function tagged with
 * `cacheTag()`. It exports a long `revalidate` window so the route-handler ISR
 * entry is only ever invalidated on demand via
 * `revalidateTag("use-cache-rh-tag")`, never by time — a plain second GET must
 * serve the cached timestamp (HIT).
 *
 * Repro for issue #1453 (route-handler revalidate sub-part): `cacheTag()` tags
 * declared inside a `"use cache"` function were attached only to the inner data
 * cache entry, never to the surrounding route-handler ISR entry, so
 * `revalidateTag()` could not evict the cached route-handler response.
 */
import { cacheTag } from "next/cache";

// Long revalidate window so the route-handler ISR entry is only invalidated on
// demand via `revalidateTag("use-cache-rh-tag")`, never by time.
export const revalidate = 3600;

async function getTaggedPayload() {
  "use cache";
  cacheTag("use-cache-rh-tag");
  return { timestamp: Date.now() };
}

export async function GET() {
  const payload = await getTaggedPayload();
  return Response.json(payload);
}
