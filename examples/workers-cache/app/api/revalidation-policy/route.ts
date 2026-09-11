export async function GET(request: Request): Promise<Response> {
  return Response.json(
    { renderId: crypto.randomUUID() },
    {
      headers: {
        "Cache-Control":
          request.headers.get("x-cacheability-seed") === "1"
            ? "public, max-age=1, stale-while-revalidate=60"
            : "no-store",
      },
    },
  );
}
