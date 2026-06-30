import { unstable_cache } from "next/cache";
import { draftMode } from "next/headers";

const getCachedData = unstable_cache(
  async () => ({
    data: Math.random().toString(36).slice(2),
    draftMode: (await draftMode()).isEnabled,
  }),
  ["nextjs-compat-unstable-cache-draft-dynamic-error-route"],
);

export const dynamic = "error";

export async function GET() {
  return Response.json(await getCachedData());
}
