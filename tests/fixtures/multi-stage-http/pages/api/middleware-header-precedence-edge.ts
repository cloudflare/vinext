// middleware.ts sets the headers below and a cookie. Edge Pages API routes
// keep vinext's middleware-wins merge, with or without response staging.
export const config = { runtime: "edge" };

export default function handler() {
  const headers = new Headers({
    "WWW-Authenticate": 'Bearer realm="handler"',
    "x-header-precedence": "handler",
  });
  headers.append("Set-Cookie", "handler-cookie=1; Path=/");
  return new Response("unauthorized", { headers, status: 401 });
}
