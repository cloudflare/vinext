import { draftMode } from "next/headers";

export async function GET() {
  (await draftMode()).enable();
  return Response.json(
    { enabled: true },
    {
      headers: {
        "cdn-cache-control": "public, s-maxage=60",
        "cloudflare-cdn-cache-control": "public, s-maxage=60",
        "cache-tag": "draft-enable",
      },
    },
  );
}
