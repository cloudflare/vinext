import type { NextRequest } from "next/server";

export const config = { runtime: "edge" };

// The Pages Router edge API counterpart of app/api/websocket-upgrade: a
// Workers WebSocket upgrade (status 101 with a `webSocket`). Regression
// coverage for #4661.
export default function handler(request: NextRequest) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const session = request.cookies.get("session")?.value ?? "anonymous";
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => {
    server.send(`${session}:${String(event.data)}`);
  });
  // `?edge-policy` adds the Cloudflare edge policy the CDN adapters strip, and
  // `?route-miss` vinext's reserved route-miss marker.
  const headers: Record<string, string> = {};
  if (request.nextUrl.searchParams.has("edge-policy")) {
    headers["Cloudflare-CDN-Cache-Control"] = "no-store";
  }
  if (request.nextUrl.searchParams.has("route-miss")) headers["x-vinext-route-miss"] = "1";
  // `?cookie` sets the cookie middleware also sets on it.
  if (request.nextUrl.searchParams.has("cookie")) {
    headers["Set-Cookie"] = "websocket-upgrade=1; Path=/";
  }
  return new Response(null, { status: 101, webSocket: client, headers } as ResponseInit);
}
