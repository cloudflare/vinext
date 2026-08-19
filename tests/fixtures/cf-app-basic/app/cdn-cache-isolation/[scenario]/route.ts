import { draftMode } from "next/headers";

export const revalidate = 60;

// Deliberately outside the fixture middleware matcher. This isolates the CDN
// credential-key behavior from the separate rule that middleware-covered
// routes cannot be admitted to Workers Cache (a cache hit would skip
// middleware on the next request).
export async function GET() {
  return Response.json({
    draftMode: (await draftMode()).isEnabled,
    token: crypto.randomUUID(),
  });
}
