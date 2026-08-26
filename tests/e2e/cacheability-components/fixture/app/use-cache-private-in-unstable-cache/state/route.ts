import {
  getPrivateExecutions,
  getPrivateFillState,
  releasePrivateFillGate,
  resetPrivateFillGate,
} from "../state";
import { getDataCacheHandler } from "vinext/shims/cache-handler";

const legacyCacheKey = "unstable_cache:cacheability-use-cache-private-in-unstable-cache:[]";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("details") === "1") {
    const fill = await getPrivateFillState();
    return Response.json({
      privateExecutions: getPrivateExecutions(),
      privateFillExecutions: fill.executions,
      privateFillWaiting: fill.waiting,
    });
  }
  return Response.json({ privateExecutions: getPrivateExecutions() });
}

export async function POST(request: Request) {
  const action = new URL(request.url).searchParams.get("action");
  if (action === "release") {
    await releasePrivateFillGate();
    return new Response(null, { status: 204 });
  }
  if (action === "reset") {
    await resetPrivateFillGate();
  } else {
    // A failed/retried concurrency assertion must not leave later requests
    // waiting on a gate from the previous attempt.
    await releasePrivateFillGate();
  }
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
