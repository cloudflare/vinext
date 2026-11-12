import { cookies } from "next/headers";

// Proxies a WebSocket upgrade and returns the upstream `fetch()` response,
// whose headers are immutable, as a service-binding proxy does. Regression
// coverage for #4661.
export async function GET(request: Request) {
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  // `?route-miss` proxies an upstream upgrade carrying vinext's reserved
  // route-miss marker.
  const upstream = new URL(request.url).searchParams.has("route-miss")
    ? "/api/websocket-upgrade-pages?route-miss"
    : "/api/websocket-upgrade";
  return fetch(new URL(upstream, request.url), {
    headers: { cookie: `session=proxied-${session}`, upgrade: "websocket" },
  });
}
