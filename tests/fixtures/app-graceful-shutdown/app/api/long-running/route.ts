import { setTimeout } from "node:timers/promises";

// Ported from Next.js: test/production/graceful-shutdown/src/pages/api/long-running.ts
export const dynamic = "force-dynamic";

export async function GET() {
  await setTimeout(400);
  return Response.json({ hello: "world" });
}
