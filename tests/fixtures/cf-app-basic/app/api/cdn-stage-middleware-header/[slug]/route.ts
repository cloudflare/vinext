export function GET(request: Request) {
  return new Response(request.headers.get("x-from-middleware") ?? "missing", {
    headers: { "Cache-Control": "public, s-maxage=60" },
  });
}
