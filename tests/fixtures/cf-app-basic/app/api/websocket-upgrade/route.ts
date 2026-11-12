import { cookies } from "next/headers";

// A Workers WebSocket upgrade (status 101 with a `webSocket`) from a handler
// that reads cookies, so vinext treats the response as private. Regression
// coverage for #4661.
export async function GET(request: Request) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => {
    server.send(`${session}:${String(event.data)}`);
  });
  // `?edge-policy` adds the Cloudflare edge policy the CDN adapters strip.
  const headers: Record<string, string> = new URL(request.url).searchParams.has("edge-policy")
    ? { "Cloudflare-CDN-Cache-Control": "no-store" }
    : {};
  return new Response(null, { status: 101, webSocket: client, headers } as ResponseInit);
}
