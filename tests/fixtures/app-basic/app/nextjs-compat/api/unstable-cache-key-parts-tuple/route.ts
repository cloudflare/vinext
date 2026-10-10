import { unstable_cache } from "next/cache";

export const dynamic = "force-dynamic";

// Keys one callback by the requested (tenant, scope, id) tuple. Tuples whose
// parts join to the same string, like ["a:b", "c"] and ["a", "b:c"], must
// still keep separate entries.
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const tenant = searchParams.get("tenant") ?? "";
  const scope = searchParams.get("scope") ?? "";
  const id = searchParams.get("id") ?? "";

  const getRecord = unstable_cache(
    async () => ({ tenant, scope, id, nonce: Math.random().toString(36).slice(2) }),
    [tenant, scope, id],
  );
  return Response.json(await getRecord());
}
