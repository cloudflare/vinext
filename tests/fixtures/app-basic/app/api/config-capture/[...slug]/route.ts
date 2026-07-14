export async function GET(request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return Response.json({
    slug,
    query: Object.fromEntries(new URL(request.url).searchParams),
  });
}
