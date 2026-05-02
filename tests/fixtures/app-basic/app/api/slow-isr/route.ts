/**
 * Slow GET route handler for SWR non-blocking test.
 *
 * Test pattern adapted from Next.js fixture:
 * test/e2e/app-dir/use-cache-swr/app/delayed-route/route.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-swr/app/delayed-route/route.ts
 *
 * This handler has a deliberate 1s delay to simulate expensive computation.
 * The STALE response must return immediately without blocking on the
 * background regeneration.
 */
export const revalidate = 1;

export async function GET() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return Response.json({
    timestamp: Date.now(),
    message: "slow ISR data",
  });
}
