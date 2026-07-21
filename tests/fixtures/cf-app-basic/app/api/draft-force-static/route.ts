import { draftMode } from "next/headers";

// Next.js tracks draftMode().enable() as dynamic even when request APIs are
// force-static: packages/next/src/server/request/draft-mode.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/request/draft-mode.ts
export const dynamic = "force-static";
export const revalidate = 60;

export async function GET() {
  const draft = await draftMode();
  draft.enable();
  return Response.json({
    draftMode: draft.isEnabled,
    token: crypto.randomUUID(),
  });
}
