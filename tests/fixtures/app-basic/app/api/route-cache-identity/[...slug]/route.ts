export const revalidate = 3600;
export const dynamic = "force-static";

export function GET(request: Request) {
  return new Response(`CACHE_IDENTITY_API_ROUTE:${new URL(request.url).pathname}`);
}
