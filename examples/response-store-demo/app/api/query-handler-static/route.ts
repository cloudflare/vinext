// Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
export const dynamic = "force-static";

export function GET(request: Request) {
  return Response.json({ id: crypto.randomUUID(), search: new URL(request.url).search });
}
