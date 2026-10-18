// middleware.ts sets every header below (plus Proxy-Authenticate and its own
// cookie). As in Next.js, this edge handler's headers are appended after
// middleware's, so a header both set carries both values.
export const config = { runtime: "edge" };

export default function handler() {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="handler"',
    "x-header-precedence": "handler",
  });
  headers.append("Set-Cookie", "handler-cookie=1; Path=/");
  return new Response("unauthorized", { headers, status: 401 });
}
