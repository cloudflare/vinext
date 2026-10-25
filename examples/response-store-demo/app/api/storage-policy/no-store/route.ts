export const revalidate = 60;

export function GET() {
  return Response.json({ renderId: crypto.randomUUID() }, { headers: { "Cache-Control": "no-store" } });
}
