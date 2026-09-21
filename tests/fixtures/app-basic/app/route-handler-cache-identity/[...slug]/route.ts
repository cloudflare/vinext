export const revalidate = 3600;
export const dynamic = "force-static";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  return new Response(
    `CACHE_IDENTITY_ROUTE_CATCH_ALL:${(await params).slug.join(":")}:${new URL(request.url).pathname}`,
  );
}
