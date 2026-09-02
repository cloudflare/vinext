export const revalidate = 60;

export function GET(request: Request): Response {
  return Response.json(
    {
      "data-render-token": crypto.randomUUID(),
      nextUrl: request.headers.get("Next-Url"),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "CDN-Cache-Control": "public, s-maxage=60",
        Vary: "Next-Url",
      },
    },
  );
}
