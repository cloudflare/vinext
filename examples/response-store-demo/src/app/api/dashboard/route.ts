// A Route Handler that proxy.ts protects, like the dashboard page.
export function GET(): Response {
  return Response.json({ dashboard: true });
}
