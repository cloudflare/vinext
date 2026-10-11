import { revalidateTag, unstable_cache } from "next/cache";

export const dynamic = "force-dynamic";

// An untagged unstable_cache called inside a tagged one, as in Next.js's
// app-static fixture. `?revalidate=1` revalidates the outer entry's tag.
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get("id") ?? "";
  const tag = `unstable-cache-nested-${id}`;

  if (searchParams.get("revalidate") === "1") {
    revalidateTag(tag);
    return Response.json({ revalidated: true });
  }

  const getInner = unstable_cache(
    async () => ({ nonce: Math.random().toString(36).slice(2) }),
    ["unstable-cache-nested-inner", id],
    { revalidate: 360 },
  );
  const getOuter = unstable_cache(() => getInner(), ["unstable-cache-nested-outer", id], {
    revalidate: 1000,
    tags: [tag],
  });
  return Response.json(await getOuter());
}
