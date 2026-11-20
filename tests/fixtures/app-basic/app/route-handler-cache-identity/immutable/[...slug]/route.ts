export const revalidate = 3600;

export function GET(request: Request) {
  return new Response(`CACHE_IDENTITY_IMMUTABLE_ROUTE:${new URL(request.url).pathname}`, {
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
