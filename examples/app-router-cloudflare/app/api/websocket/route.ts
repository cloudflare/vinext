import { cookies } from "next/headers";

// A Workers WebSocket upgrade (status 101 with a `webSocket`). Reading the
// cookie makes the handler dynamic, so vinext marks the response private.
// Coverage: tests/e2e/cloudflare-workers/route-handler-websocket.spec.ts
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
  return new Response(null, { status: 101, webSocket: client });
}
