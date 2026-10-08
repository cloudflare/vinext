export const revalidate = false;

export function GET() {
  return Response.json({ renderId: crypto.randomUUID() }, { headers: { "Cache-Control": "no-store" } });
}
