// next.config.ts adds a config Set-Cookie to this route, and middleware.ts sets
// its own cookie when `?middleware-cookie` is present. As in Next.js, the
// config cookie precedes the handler's and is dropped when middleware sets one.
export function GET() {
  return new Response("ok", { headers: { "Set-Cookie": "handler-cookie=1; Path=/" } });
}
