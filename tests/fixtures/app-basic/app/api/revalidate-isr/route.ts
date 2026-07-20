import { revalidatePath } from "next/cache";

const RESETTABLE_ISR_PATHS = new Set([
  "/isr-test",
  "/client-isr-test",
  "/revalidate-test",
  "/revalidate-tag-test",
  "/revalidate-tag-test/nested",
]);

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path");
  if (!path || !RESETTABLE_ISR_PATHS.has(path)) {
    return new Response("Invalid path", { status: 400 });
  }

  revalidatePath(path);
  return new Response("ok");
}
