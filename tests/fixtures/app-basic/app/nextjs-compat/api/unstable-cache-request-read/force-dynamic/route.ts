import { unstable_cache } from "next/cache";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const readSession = unstable_cache(
    async () => request.cookies.get("session")?.value ?? null,
    ["nextjs-compat-unstable-cache-request-read-force-dynamic"],
  );
  return Response.json({ session: await readSession() });
}
