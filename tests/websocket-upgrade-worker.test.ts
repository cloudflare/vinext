/**
 * On Cloudflare Workers, an App Router Route Handler or a Pages Router edge API
 * route may return a WebSocket upgrade: a status 101 response carrying the
 * Workers-only `webSocket` property, from a `WebSocketPair`, a service binding
 * or a Durable Object.
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
import { responseStoreAdapter } from "../packages/cloudflare/src/cache/response-store-adapter.js";
import { workersCacheCdnAdapter } from "../packages/cloudflare/src/cache/workers-cache-cdn-adapter.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options?: {
  configPath?: string;
  viteEnvironment?: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type StartedWorker = {
  url: Promise<URL>;
  raw: {
    once(
      event: "error",
      listener: (error: Error | { source: string; reason: string; cause?: unknown }) => void,
    ): void;
    teardown(): Promise<void>;
  };
};

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

type Build = {
  name: string;
  appRouter: boolean;
  cache: "none" | "workers-cache" | "response-store";
};

const BUILDS: Build[] = [
  { name: "a hybrid app", appRouter: true, cache: "none" },
  // The adapter stamps a build identity on every response.
  {
    name: "a hybrid app with the Workers Cache adapter",
    appRouter: true,
    cache: "workers-cache",
  },
  // The adapter rewrites the cache headers of every response it dispatches.
  {
    name: "a hybrid app with the Response Store adapter",
    appRouter: true,
    cache: "response-store",
  },
  { name: "a Pages Router app", appRouter: false, cache: "none" },
  {
    name: "a Pages Router app with the Workers Cache adapter",
    appRouter: false,
    cache: "workers-cache",
  },
  {
    name: "a Pages Router app with the Response Store adapter",
    appRouter: false,
    cache: "response-store",
  },
];

function cacheOption(build: Build) {
  if (build.cache === "workers-cache") return { cache: { cdn: workersCacheCdnAdapter() } };
  if (build.cache === "response-store") {
    return { cache: responseStoreAdapter({ mode: "self-contained" }) };
  }
  return {};
}

describe.each(BUILDS)("WebSocket upgrades on the Workers runtime in $name", (build) => {
  let root = "";
  let worker: StartedWorker | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-websocket-upgrade-worker-",
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
        vinext({
          appDir: root,
          ...cacheOption(build),
          ...(build.appRouter ? {} : { disableAppRouter: true }),
        }),
        cloudflare({
          ...(build.cache === "response-store"
            ? { configPath: path.join(root, "wrangler.response-store.jsonc") }
            : {}),
          ...(build.appRouter
            ? { viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }
            : {}),
        }),
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
    const started = await wrangler.unstable_startWorker({
      config: path.join(
        root,
        build.appRouter ? "dist/server" : "dist/cf_app_basic",
        "wrangler.json",
      ),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { hostname: "127.0.0.1", port: 0 },
        inspector: false,
      },
    });
    worker = started;
    // wrangler reports startup failures as `error` events and leaves `url`
    // pending, so fail with the cause instead of waiting out the hook timeout.
    const startupError = new Promise<never>((_, reject) => {
      started.raw.once("error", (error) => {
        reject(
          error instanceof Error
            ? error
            : new Error(`${error.source}: ${error.reason}`, { cause: error.cause }),
        );
      });
    });
    baseUrl = (await Promise.race([started.url, startupError])).origin;
  }, 180_000);

  afterAll(async () => {
    // `dispose()` waits for a startup that may never finish; tear down directly.
    await worker?.raw.teardown();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  function webSocketUrl(pathname: string): string {
    const url = new URL(pathname, baseUrl);
    url.protocol = "ws:";
    return url.href;
  }

  it.runIf(build.appRouter)(
    "completes the upgrade a cookie-reading Route Handler returns",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("abc:ping");
    },
    30_000,
  );

  it.runIf(build.appRouter)(
    "completes an upgrade a Route Handler proxies from fetch()",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade-proxy"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("proxied-abc:ping");
    },
    30_000,
  );

  it("completes the upgrade a Pages Router edge API route returns", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade-pages"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("abc:ping");
  }, 30_000);

  it("completes an upgrade a Pages Router edge API route proxies from fetch()", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade-pages-proxy"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("proxied-abc:ping");
  }, 30_000);

  // The CDN adapters strip this policy from the response at the gateway.
  it.runIf(build.appRouter)(
    "completes a Route Handler upgrade that carries the Cloudflare edge policy",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade?edge-policy"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("abc:ping");
    },
    30_000,
  );

  it("completes a Pages Router edge API upgrade that carries the Cloudflare edge policy", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade-pages?edge-policy"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("abc:ping");
  }, 30_000);

  // The proxied response's immutable headers carry vinext's reserved marker.
  it.runIf(build.appRouter)(
    "completes an upgrade a Route Handler proxies with the route-miss marker",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade-proxy?route-miss"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("proxied-abc:ping");
    },
    30_000,
  );

  // A Route Handler response reached through a rewrite gets a never-cache
  // policy, here on the proxied response's immutable headers.
  it.runIf(build.appRouter)(
    "completes an upgrade a rewritten Route Handler proxies from fetch()",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade-rewrite"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("proxied-abc:ping");
    },
    30_000,
  );

  // Middleware sets the same cookie the handler returns, which the response
  // stage could take for the copy the handler inherited.
  it("completes a Pages Router edge API upgrade that sets the cookie middleware sets", async () => {
    await expect(
      exchangeWebSocketMessage(
        webSocketUrl("/api/websocket-upgrade-pages?cookie"),
        { cookie: "session=abc" },
        "ping",
      ),
    ).resolves.toBe("abc:ping");
  }, 30_000);

  // Middleware enables draft mode on `?draft=true`, so its cookie is pending.
  it.runIf(build.appRouter)(
    "completes a Route Handler upgrade while middleware enables draft mode",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade?draft=true"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("abc:ping");
    },
    30_000,
  );

  // Pages-only middleware has no draftMode() scope in this fixture.
  it.runIf(build.appRouter)(
    "completes a Pages Router edge API upgrade while middleware enables draft mode",
    async () => {
      await expect(
        exchangeWebSocketMessage(
          webSocketUrl("/api/websocket-upgrade-pages?draft=true"),
          { cookie: "session=abc" },
          "ping",
        ),
      ).resolves.toBe("abc:ping");
    },
    30_000,
  );
});
