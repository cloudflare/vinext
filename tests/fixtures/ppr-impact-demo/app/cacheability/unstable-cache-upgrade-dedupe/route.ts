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
  return Response.json({ executions, values });
}
