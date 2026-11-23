import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");
const CELL_COUNT = 60;
const LARGE_CELL_COUNT = 12_000;

async function renderedCells(url: URL): Promise<{ count: number; table: string }> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const table = html.match(/<table id="collection">([\s\S]*?)<\/table>/)?.[1] ?? "";
  return { count: table.match(/<tr>/g)?.length ?? 0, table };
}

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

async function loadCloudflarePlugin(root: string): Promise<CloudflarePluginFactory> {
  const cloudflarePluginPath = path.join(
    root,
    "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
  );
  const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  return cloudflare;
}

type StartedWorker = {
  url: Promise<URL>;
  dispose(): Promise<void>;
};

// #4770, on the Workers runtime: workerd's streams and the edge React
// renderers schedule the SSR Flight client's reads differently from Node.
// A collection that registers its items from a hidden copy of its children
// (react-aria-components' Table) must still be server-rendered whole.
describe("App Router SSR of a collection built from its children on the Workers runtime", () => {
  let root = "";
  let worker: StartedWorker | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-ssr-collection-worker-",
      undefined,
      CLOUDFLARE_NODE_MODULES,
    );
    const cloudflare = await loadCloudflarePlugin(root);
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
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
          inspector: { port: 0 };
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
        inspector: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("server-renders every item of the collection", async () => {
    // A few requests, so a warm isolate is covered as well as a cold one.
    for (let request = 0; request < 3; request += 1) {
      const { count, table } = await renderedCells(new URL("/ssr-collection", baseUrl));
      expect(count).toBe(CELL_COUNT);
      expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
    }
  }, 60_000);

  it("server-renders every item of a collection whose payload is several MB", async () => {
    const { count, table } = await renderedCells(new URL("/ssr-collection/large", baseUrl));
    expect(count).toBe(LARGE_CELL_COUNT);
    expect(table).toContain(`cell-${LARGE_CELL_COUNT - 1}-`);
  }, 60_000);

  // A boundary's content comes in a later flush, after the shell, or while
  // React is still writing the first one. Several requests, so a warm server
  // is covered: the first one can be slow enough to hide the race.
  it.each([
    ["streamed after the shell", "/ssr-collection/streamed"],
    ["awaited in the first flush", "/ssr-collection/awaited"],
  ])(
    "server-renders every item of a collection in a Suspense boundary, %s",
    async (_, route) => {
      for (let request = 0; request < 3; request += 1) {
        const { count, table } = await renderedCells(new URL(route, baseUrl));
        expect(count).toBe(CELL_COUNT);
        expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
      }
    },
    60_000,
  );
});

describe("App Router dev SSR of a collection built from its children on the Workers runtime", () => {
  let root = "";
  let server: ViteDevServer | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-ssr-collection-worker-dev-",
      undefined,
      CLOUDFLARE_NODE_MODULES,
    );
    const cloudflare = await loadCloudflarePlugin(root);
    server = await createServer({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer?.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    // On a cold dependency cache the first request can fail while Vite
    // discovers and optimizes the Worker's dependencies, which is unrelated
    // to the collection. Wait until the page renders once.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(new URL("/ssr-collection", baseUrl));
      await response.arrayBuffer();
      if (response.ok) break;
    }
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Several requests: the first one compiles the page and is slow enough to
  // hide the race.
  it.each([
    ["at the root", "/ssr-collection", CELL_COUNT],
    ["whose payload is several MB", "/ssr-collection/large", LARGE_CELL_COUNT],
    ["in a Suspense boundary streamed after the shell", "/ssr-collection/streamed", CELL_COUNT],
    ["in a Suspense boundary awaited in the first flush", "/ssr-collection/awaited", CELL_COUNT],
  ])(
    "server-renders every item of a collection %s",
    async (_, route, cells) => {
      for (let request = 0; request < 3; request += 1) {
        const { count, table } = await renderedCells(new URL(route, baseUrl));
        expect(count).toBe(cells);
        expect(table).toContain(`cell-${cells - 1}-`);
      }
    },
    60_000,
  );
});
