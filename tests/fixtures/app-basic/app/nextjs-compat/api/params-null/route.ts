// Non-dynamic route handler: `context.params` should be null (not `{}`)
// in Next.js. User code typically does `params ? await params : null`,
// and the result must be observable as `null`.
//
// See Next.js test:
// test/e2e/app-dir/app-routes/app-custom-routes.test.ts
// - "does not provide params to routes without dynamic parameters"
type ParamsContext = { params?: Promise<Record<string, string | string[]>> };

export async function GET(_request: Request, context: ParamsContext) {
  const params = context.params;
  const resolved = params ? await params : null;
  return Response.json({ params: resolved });
}
