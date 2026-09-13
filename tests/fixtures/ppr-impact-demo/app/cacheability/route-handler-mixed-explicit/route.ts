export function GET() {
  return Response.json(
    { kind: "explicit-mixed-route-handler" },
    { headers: { "Cache-Control": "public, s-maxage=60" } },
  );
}

export function POST() {
  return new Response(null, { status: 204 });
}
