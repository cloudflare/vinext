const policies: Record<string, Record<string, string>> = {
  browser: {
    "Cache-Control": "max-age=10",
    "Cloudflare-CDN-Cache-Control": "max-age=3600",
  },
  shared: { "Cache-Control": "public, max-age=10, s-maxage=3600, stale-while-revalidate=60" },
  independent: {
    "Cache-Control": "max-age=10, stale-while-revalidate=60",
    "CDN-Cache-Control": "max-age=3600",
  },
  private: {
    "Cache-Control": "private, max-age=10",
    "Cloudflare-CDN-Cache-Control": "max-age=3600",
  },
  "private-only": { "Cache-Control": "private, max-age=10" },
  "bot-blocked": { "Cache-Control": "max-age=10", "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  proxy: { "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  "edge-no-store": { "Cache-Control": "public, max-age=10", "Cloudflare-CDN-Cache-Control": "no-store" },
  "short-browser": { "Cache-Control": "max-age=1", "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  "short-store": { "Cache-Control": "max-age=3600", "Cloudflare-CDN-Cache-Control": "max-age=1" },
  middleware: { "Cache-Control": "max-age=10", "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  config: { "Cache-Control": "max-age=10", "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  "no-cache": { "Cache-Control": "public, max-age=10, no-cache", "Cloudflare-CDN-Cache-Control": "max-age=3600" },
  "no-store": { "Cache-Control": "no-store" },
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ policy: string }> },
) {
  const { policy } = await params;
  const policyHeaders = policies[policy];
  const headers = policyHeaders ? new Headers(policyHeaders) : null;
  if (headers && policy === "private-only") {
    headers.set("X-Private-Visitor", request.headers.get("x-private-visitor") ?? "anonymous");
  }
  return headers
    ? Response.json({ policy, renderId: crypto.randomUUID() }, { headers })
    : new Response("Not found", { status: 404 });
}
