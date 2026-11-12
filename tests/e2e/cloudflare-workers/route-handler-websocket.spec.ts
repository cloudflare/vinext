import { expect, test } from "@playwright/test";

type SocketResult = { message?: string; closeCode?: number; error?: true };

// Node's WebSocket (undici) takes extra handshake headers here.
function exchange(url: string, cookie: string): Promise<SocketResult> {
  const socket = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
  return new Promise((resolve) => {
    socket.addEventListener("open", () => socket.send("ping"));
    socket.addEventListener("message", (event) => {
      resolve({ message: String(event.data) });
      socket.close();
    });
    socket.addEventListener("error", () => resolve({ error: true }));
    socket.addEventListener("close", (event) => resolve({ closeCode: event.code }));
  });
}

// A Route Handler on Workers may answer with a WebSocket upgrade: status 101
// with a `webSocket`, from `WebSocketPair`, a Durable Object or a service
// binding. vinext used to rebuild it with `new Response()`: to mark the
// cookie-reading handler private, in cacheability admission and in the
// Response Store gateway. That throws for status 101, so the route answered
// 500 and the socket never opened. Runs on `wrangler dev` (cloudflare-workers)
// and `vp dev` (cloudflare-dev), both with the Response Store adapter.
// https://developers.cloudflare.com/workers/runtime-apis/websockets/
// Fixture: examples/app-router-cloudflare/app/api/websocket/route.ts
test.describe("App Route Handler WebSocket upgrades on Workers", () => {
  test("a cookie-reading route handler completes the upgrade", async ({ baseURL }) => {
    if (!baseURL) throw new Error("Expected the project's baseURL");
    const url = `${baseURL.replace(/^http/, "ws")}/api/websocket`;
    expect(await exchange(url, "session=visitor-1")).toEqual({ message: "visitor-1:ping" });
  });

  test("the same route keeps its private policy for a plain request", async ({
    baseURL,
    request,
  }) => {
    const response = await request.get(`${baseURL}/api/websocket`);
    expect(response.status()).toBe(426);
    expect(response.headers()["cache-control"]).toContain("no-store");
  });
});
