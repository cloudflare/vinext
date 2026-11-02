import { revalidateTag } from "next/cache";
import {
  nestedUnstableCacheTag,
  readNestedUnstableCache,
} from "../../../../lib/nested-unstable-cache";

export const dynamic = "force-dynamic";

// `?revalidate=1` revalidates the outer entry's tag.
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const id = searchParams.get("id") ?? "";

  if (searchParams.get("revalidate") === "1") {
    revalidateTag(nestedUnstableCacheTag(id));
    return Response.json({ revalidated: true });
  }

  return Response.json(await readNestedUnstableCache(id));
}
