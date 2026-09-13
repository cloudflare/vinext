export const revalidate = 60;

type CloudflareRequest = Request & {
  cf?: { cacheKey?: string };
};

export async function GET(request: Request) {
  const cf = (request as CloudflareRequest).cf;
  const clonedCf = (request.clone() as CloudflareRequest).cf;
  return Response.json({
    marker: cf?.cacheKey,
    clonedMarker: clonedCf?.cacheKey,
  });
}
