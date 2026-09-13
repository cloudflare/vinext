/**
 * Route handler that sets its own Cache-Control header.
 * Used to verify that `export const revalidate` does not override
 * handler-set Cache-Control.
 */
export const revalidate = 60;

// Ported from Next.js:
// test/e2e/vary-header/app/app/normal/route.js
// A request API read does not override an explicit response cache policy.
export async function GET(request: Request) {
  return new Response(JSON.stringify({ ok: true, userAgent: request.headers.get("user-agent") }), {
    headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
  });
}
