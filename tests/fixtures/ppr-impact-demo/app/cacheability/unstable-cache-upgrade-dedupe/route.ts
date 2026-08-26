import { unstable_cache } from "next/cache";
import { getDataCacheHandler } from "vinext/shims/cache-handler";

const cacheKey = "unstable_cache:cacheability-upgrade-dedupe:[]";
let executions = 0;

const readValue = unstable_cache(async () => {
  executions++;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return executions;
}, ["cacheability-upgrade-dedupe"]);

export async function POST() {
  executions = 0;
  await getDataCacheHandler().set(
    cacheKey,
    {
      kind: "FETCH",
      data: {
        body: JSON.stringify({ v: "legacy-result" }),
        headers: {},
        url: cacheKey,
      },
      revalidate: false,
      tags: [],
    },
    { fetchCache: true, tags: [] },
  );
  return new Response(null, { status: 204 });
}

export async function GET() {
  const values = await Promise.all([readValue(), readValue(), readValue()]);
  const entry = await getDataCacheHandler().get(cacheKey, { kind: "FETCH", tags: [] });
  if (!entry?.value || entry.value.kind !== "FETCH") {
    throw new Error("expected upgraded unstable_cache entry");
  }
  const wrapper = JSON.parse(entry.value.data.body) as Record<string, unknown>;
  // Simulate the reader still deployed in the old Worker version. During a
  // staged rollout it only understands `v` / `undef`, while the new reader
  // requires the versioned fields and rejects old payloads.
  const legacyReaderValue = "undef" in wrapper ? undefined : wrapper.v;
  return Response.json({ executions, legacyReaderValue, storedVersion: wrapper.version, values });
}
