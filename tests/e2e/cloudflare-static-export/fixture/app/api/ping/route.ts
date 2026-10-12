export const dynamic = "force-static";

// The configured /api/* Worker-first route exercises Cloudflare's hybrid path.
export function GET() {
  return Response.json({ from: "worker" }, { headers: { "x-worker-route": "yes" } });
}
