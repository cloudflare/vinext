type RouteContext = { params: Promise<{ slugs: string[] }> };

export async function GET(request: Request, { params }: RouteContext) {
  const url = new URL(request.url);
  return Response.json({
    body: null,
    cookie: request.headers.get("cookie"),
    header: request.headers.get("x-api-fallback-handoff"),
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams),
    slugs: (await params).slugs,
  });
}
