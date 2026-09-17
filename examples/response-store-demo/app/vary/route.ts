export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const variant = request.headers.get("x-cache-variant") ?? "missing";
  return new Response(variant, {
    headers: {
      "Cache-Control": "public, s-maxage=300",
      Vary: "x-cache-variant",
    },
  });
}
