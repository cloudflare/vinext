import { draftMode } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const draft = await draftMode();
  draft.enable();
  return NextResponse.json(
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
