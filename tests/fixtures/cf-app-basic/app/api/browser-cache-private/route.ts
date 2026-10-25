export function GET(request: Request) {
  return Response.json(
    { browserCache: true },
    {
      headers: {
        "Cache-Control": "private, max-age=300",
        "X-Private-Visitor": request.headers.get("x-private-visitor") ?? "anonymous",
      },
    },
  );
}
