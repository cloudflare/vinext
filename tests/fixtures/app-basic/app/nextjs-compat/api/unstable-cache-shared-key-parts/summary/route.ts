import { unstable_cache } from "next/cache";

// Shares its keyParts with ../receipt/route.ts. Next.js keys unstable_cache by
// the callback source as well as keyParts, so the two never share an entry.
const getSummary = unstable_cache(
  async (orderId: string) => ({
    kind: "summary",
    orderId,
    nonce: Math.random().toString(36).slice(2),
  }),
  ["nextjs-compat-unstable-cache-shared-key-parts"],
);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const orderId = new URL(request.url).searchParams.get("id") ?? "default";
  return Response.json(await getSummary(orderId));
}
