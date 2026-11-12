import { cookies } from "next/headers";

// Proxies a WebSocket upgrade and returns the upstream `fetch()` response,
// whose headers are immutable, as a service-binding proxy does. Regression
// coverage for #4661.
export async function GET(request: Request) {
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  return fetch(new URL("/api/websocket-upgrade", request.url), {
    headers: { cookie: `session=proxied-${session}`, upgrade: "websocket" },
  });
}
