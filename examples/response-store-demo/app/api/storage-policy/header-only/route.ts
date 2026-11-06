export function GET() {
  return Response.json({ renderId: crypto.randomUUID() }, { headers: { "Cache-Control": "public, max-age=3600" } });
}
