export const revalidate = 3600;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  return new Response(`CACHE_IDENTITY_ROUTE_CATCH_ALL:${(await params).slug.join("/")}`);
}
