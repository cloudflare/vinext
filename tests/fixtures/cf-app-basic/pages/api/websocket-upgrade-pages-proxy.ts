import type { NextRequest } from "next/server";

export const config = { runtime: "edge" };

// Proxies a WebSocket upgrade and returns the upstream `fetch()` response,
// whose headers are immutable, as a service-binding proxy does. Regression
// coverage for #4661.
export default function handler(request: NextRequest) {
  const session = request.cookies.get("session")?.value ?? "anonymous";
  return fetch(new URL("/api/websocket-upgrade-pages", request.url), {
    headers: { cookie: `session=proxied-${session}`, upgrade: "websocket" },
  });
}
