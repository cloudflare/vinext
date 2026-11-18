import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");
const CELL_COUNT = 60;

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

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
      const response = await fetch(new URL("/ssr-collection", baseUrl));
      expect(response.status).toBe(200);
      const html = await response.text();
      const table = html.match(/<table id="collection">([\s\S]*?)<\/table>/)?.[1] ?? "";
      expect(table.match(/<tr>/g)?.length ?? 0).toBe(CELL_COUNT);
      expect(table).toContain(`cell-${CELL_COUNT - 1}-`);
    }
  }, 60_000);
});
