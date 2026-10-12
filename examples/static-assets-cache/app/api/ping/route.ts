export function GET() {
  return Response.json({ from: "worker", requestId: crypto.randomUUID() });
}
