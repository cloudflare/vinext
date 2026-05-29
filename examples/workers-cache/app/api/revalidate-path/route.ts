import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

type Body = { path?: unknown };

export async function POST(request: Request): Promise<Response> {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!path || !path.startsWith("/")) {
    return Response.json({ error: "Path must be a leading-slash route" }, { status: 400 });
  }

  // revalidatePath() invalidates the inner CacheHandler AND, when the
  // request's ExecutionContext exposes ctx.cache.purge, also purges both
  // the bare path tag and the `_N_T_<path>` form vinext emits on the
  // response Cache-Tag header.
  await revalidatePath(path);
  return Response.json({ revalidated: true, target: path });
}
