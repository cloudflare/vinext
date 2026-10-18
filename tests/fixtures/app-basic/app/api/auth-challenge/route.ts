// middleware.ts adds its own challenges (and a singular x-auth-source header)
// to this route. As in Next.js, the handler's WWW-Authenticate and
// Proxy-Authenticate values are kept after middleware's, while middleware still
// owns singular headers.
export function GET() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Bearer realm="handler"',
      "Proxy-Authenticate": 'Bearer realm="handler"',
      "x-auth-source": "handler",
    },
  });
}
