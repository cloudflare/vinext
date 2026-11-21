// As in Next.js, an edge Route Handler's own headers follow config's.
export const runtime = "edge";

export function GET() {
  return new Response(null, {
    headers: {
      "X-Config-Collision": "handler",
      "WWW-Authenticate": "Basic realm=handler",
    },
  });
}
