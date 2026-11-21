// next.config.ts sets the same headers for this route. As in Next.js, a Node
// Route Handler's own value yields to config, and challenges are kept after it.
export function GET() {
  return new Response(null, {
    headers: {
      "X-Config-Collision": "handler",
      "WWW-Authenticate": "Basic realm=handler",
    },
  });
}
