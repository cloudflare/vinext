// Ported from Next.js: test/production/graceful-shutdown/src/pages/api/fast.ts
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ hello: "world" });
}
