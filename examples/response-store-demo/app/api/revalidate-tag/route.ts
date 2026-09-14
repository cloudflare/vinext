import { revalidateTag } from "next/cache";

export const dynamic = "force-dynamic";

type Body = { tag?: unknown };

export async function POST(request: Request): Promise<Response> {
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tag = typeof payload.tag === "string" ? payload.tag.trim() : "";
  if (!tag) return Response.json({ error: "Missing tag" }, { status: 400 });

  // The configured Workers Response Store adapter indexes and purges this tag.
  // Next.js 16's revalidateTag signature requires a cacheLife profile; pass
  // the "default" profile to mirror typical SWR semantics for the demo.
  await revalidateTag(tag, "default");
  return Response.json({ revalidated: true, target: tag });
}
