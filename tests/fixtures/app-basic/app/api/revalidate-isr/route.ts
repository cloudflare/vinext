import { revalidatePath } from "next/cache";

const RESETTABLE_ISR_PATHS = new Set([
  "/isr-test",
  "/client-isr-test",
  "/revalidate-test",
  "/revalidate-tag-test",
  "/revalidate-tag-test/nested",
  "/route-cache-identity",
  "/route-cache-identity/about",
  "/route-cache-identity/nested/about",
  "/route-handler-cache-identity/about",
  "/route-handler-cache-identity/dynamic/alpha",
  "/route-handler-cache-identity/rewrite",
  "/api/route-cache-identity/trailing",
  "/api/route-cache-identity/trailing/",
]);

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path");
  if (!path || !RESETTABLE_ISR_PATHS.has(path)) {
    return new Response("Invalid path", { status: 400 });
  }

  revalidatePath(path);
  return new Response("ok");
}
