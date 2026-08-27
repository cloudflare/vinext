export const revalidate = 60;

export function GET(request: Request) {
  return Response.json(
    { value: request.headers.get("X-Probe-Value") ?? "none" },
    { headers: { "Cache-Control": "public, s-maxage=60" } },
  );
}
