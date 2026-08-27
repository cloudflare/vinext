export const revalidate = 60;

export function GET() {
  return Response.json({ kind: "static-route-handler" }, { headers: { Vary: "User-Agent" } });
}
