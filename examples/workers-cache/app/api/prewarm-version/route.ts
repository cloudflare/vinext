export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { buildId: process.env.__VINEXT_BUILD_ID },
    { headers: { "Cache-Control": "no-store" } },
  );
}
