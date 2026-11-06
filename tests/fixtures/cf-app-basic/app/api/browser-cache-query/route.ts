export function GET(request: Request) {
  return Response.json(
    { visitor: new URL(request.url).searchParams.get("visitor") },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=600" } },
  );
}
