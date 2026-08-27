import { unstable_cache } from "next/cache";
import { getDataCacheHandler } from "vinext/shims/cache-handler";

const cacheKey = "unstable_cache:cacheability-upgrade:[]";
let executions = 0;

const readValue = unstable_cache(async () => {
  const execution = ++executions;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return execution;
}, ["cacheability-upgrade"]);

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
  // Simulate the reader still deployed in the old Worker version. It ignores
  // the version marker but continues to understand the retained `v` field.
  const legacyReaderValue = "undef" in wrapper ? undefined : wrapper.v;
  return Response.json({ executions, legacyReaderValue, storedVersion: wrapper.version, values });
}
