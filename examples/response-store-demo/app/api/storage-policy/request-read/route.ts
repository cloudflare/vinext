export const revalidate = 60;

export function GET(request: Request) {
  return Response.json({ renderId: crypto.randomUUID(), visitor: request.headers.get("x-visitor") }, { headers: { "Cache-Control": "public, max-age=300" } });
}
