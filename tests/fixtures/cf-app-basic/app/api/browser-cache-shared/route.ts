export function GET() {
  return Response.json(
    { browserCache: true },
    {
      headers: { "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=60" },
    },
  );
}
