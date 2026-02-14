export function GET() {
  return Response.json({ status: "ok", timestamp: Date.now() });
}

