export const dynamic = "force-dynamic";

export function GET() {
  return new Response("x".repeat(64 * 1024), { headers: { "content-type": "text/plain" } });
}
