import { draftMode } from "next/headers";

export async function GET() {
  (await draftMode()).disable();
  return Response.json(
    { disabled: true },
    {
      headers: {
        "cdn-cache-control": "public, s-maxage=60",
        "cloudflare-cdn-cache-control": "public, s-maxage=60",
        "cache-tag": "draft-disable",
      },
    },
  );
}
