/**
 * On Cloudflare Workers, an App Router Route Handler may return a WebSocket
 * upgrade: a status 101 response carrying the Workers-only `webSocket`
 * property, from a `WebSocketPair`, a service binding or a Durable Object.
 * workerd's `Response` constructor rejects status 101 unless the init carries
 * that `webSocket`, so the response must reach the runtime as returned.
 *
 * Runs inside the actual Workers runtime (via wrangler's workerd): Node cannot
 * construct a 101 response at all.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { workersCacheCdnAdapter } from "../packages/cloudflare/src/cache/workers-cache-cdn-adapter.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type StartedWorker = { url: Promise<URL>; dispose(): Promise<void> };

/** Opens a WebSocket and resolves with the first message it receives. */
async function exchangeWebSocketMessage(
  url: string,
  headers: Record<string, string>,
  message: string,
): Promise<string> {
  // Node's WebSocket (undici) takes extra handshake headers here.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
      socket.addEventListener("close", (event) =>
        reject(new Error(`WebSocket closed with code ${event.code}`)),
      );
      socket.addEventListener("message", (event) => resolve(String(event.data)));
      socket.addEventListener("open", () => socket.send(message), { once: true });
    });
  } finally {
    socket.close();
  }
}

describe.each([
  { name: "without a CDN adapter", options: {} },
  // The adapter stamps a build identity on every route handler response.
  { name: "with the Workers Cache adapter", options: { cache: { cdn: workersCacheCdnAdapter() } } },
])("App Route Handler WebSocket upgrades on the Workers runtime $name", ({ options }) => {
  let root = "";
  let worker: StartedWorker | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-app-route-websocket-upgrade-worker-",
      undefined,
      CLOUDFLARE_NODE_MODULES,
    );
    const cloudflarePluginPath = path.join(
      root,
      "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
    );
    const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
      cloudflare: CloudflarePluginFactory;
    };
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root, ...options }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();

    const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
    const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { hostname: string; port: 0 };
          inspector: false;
        };
      }): Promise<StartedWorker>;
    };
    worker = await wrangler.unstable_startWorker({
      config: path.join(root, "dist/server/wrangler.json"),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { hostname: "127.0.0.1", port: 0 },
        inspector: false,
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  function webSocketUrl(pathname: string): string {
    const url = new URL(pathname, baseUrl);
    url.protocol = "ws:";
    return url.href;
  }

  it("completes the upgrade a cookie-reading Route Handler returns", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("abc:ping");
  }, 30_000);

  it("completes an upgrade a Route Handler proxies from fetch()", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade-proxy"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("proxied-abc:ping");
  }, 30_000);
});
