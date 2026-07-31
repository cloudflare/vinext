/**
 * API route to trigger `revalidateTag("use-cache-rh-tag")` — invalidates the
 * cached `/api/use-cache-tagged` route handler.
 *
 * Repro support for issue #1453 (route-handler revalidate sub-part).
 */
import { revalidateTag } from "next/cache";

export async function GET() {
  revalidateTag("use-cache-rh-tag");
  return new Response("ok", { status: 200 });
}
