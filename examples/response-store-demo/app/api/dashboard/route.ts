// A Route Handler that middleware.ts protects, like the dashboard page.
export function GET(): Response {
  return Response.json({ dashboard: true });
}
