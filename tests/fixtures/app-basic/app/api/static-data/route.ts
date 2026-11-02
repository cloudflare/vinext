/**
 * Static GET route handler with revalidate config.
 *
 * In Next.js, a GET-only route handler with `export const revalidate = N`
 * gets Cache-Control: s-maxage=N, stale-while-revalidate headers.
 *
 * Uses revalidate=1 so the revalidation timing test in api-routes.spec.ts
 * can complete quickly without long sleeps.
 */
export const revalidate = 1;

export async function GET() {
  return Response.json({
    timestamp: Date.now(),
    message: "static data with revalidate=1",
  });
}
