export const revalidate = 60;

export function GET() {
  return Response.json({ kind: "framework-policy-mixed-route-handler" });
}

export function POST() {
  return new Response(null, { status: 204 });
}
