export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    {
      buildId: process.env.__VINEXT_BUILD_ID,
      rscBuildId: process.env.__VINEXT_RSC_BUILD_IDENTITY,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
