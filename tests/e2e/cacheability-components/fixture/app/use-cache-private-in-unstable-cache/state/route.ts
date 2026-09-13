import { getPrivateExecutions } from "../state";
import { getDataCacheHandler } from "vinext/shims/cache-handler";

const legacyCacheKey = "unstable_cache:cacheability-use-cache-private-in-unstable-cache:[]";

export async function GET() {
  return Response.json({ privateExecutions: getPrivateExecutions() });
}

export async function POST() {
  await getDataCacheHandler().set(
    legacyCacheKey,
    {
      kind: "FETCH",
      data: {
        body: JSON.stringify({ v: "legacy-private-output" }),
        headers: {},
        url: legacyCacheKey,
      },
      revalidate: false,
      tags: [],
    },
    { fetchCache: true, tags: [] },
  );
  return new Response(null, { status: 204 });
}
