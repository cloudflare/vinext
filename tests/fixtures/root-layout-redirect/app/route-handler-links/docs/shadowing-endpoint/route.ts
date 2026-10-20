// The catch-all docs page also matches this URL, so the client route manifest
// keeps this path to tell the two apart.
export function GET() {
  return Response.json({ endpoint: "shadowing" });
}
