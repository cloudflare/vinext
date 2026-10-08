export const revalidate = 300;

export function GET() {
  return Response.json(
    { browserCache: true },
    {
      headers: {
        "Cache-Control": "max-age=10",
        "Cloudflare-CDN-Cache-Control": "max-age=3600",
      },
    },
  );
}
