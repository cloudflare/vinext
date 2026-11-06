export function GET() {
  return Response.json(
    { browserCache: true },
    {
      headers: {
        "Cache-Control": "max-age=10, stale-while-revalidate=60",
        "Cloudflare-CDN-Cache-Control": "max-age=3600",
      },
    },
  );
}
