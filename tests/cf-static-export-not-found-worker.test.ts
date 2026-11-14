/**
 * A static export (`output: "export"`) deployed to Workers serves its
 * exported files from Static Assets, and requests that match no file fall
 * through to the Worker. Next.js exports only the params `generateStaticParams`
 * lists (it rejects `dynamicParams: true` with `output: "export"`), so every
 * other URL is a 404 there. Here the Worker renders `[locale]/[slug]` for
 * unlisted params, and `notFound()` from `generateMetadata()` answers 200.
 * Runs the built Worker in workerd (wrangler's unstable_startWorker).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-static-export");
const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

describe("static export on Workers: unmatched URLs", () => {
  let root = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-cf-static-export-",
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
        vinext({ appDir: root, prerender: { routes: "*" } }),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    await runPrerender({ root });

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
        };
      }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
    };
    worker = await wrangler.unstable_startWorker({
      config: path.join(root, "dist/server/wrangler.json"),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { hostname: "127.0.0.1", port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("serves the exported pages", async () => {
    const res = await fetch(`${baseUrl}/en/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Page (<!-- -->)?about/);
  });

  it("serves the exported route handler", async () => {
    const res = await fetch(`${baseUrl}/data/known`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "known" });
  });

  for (const pathname of [
    "/data/unknown",
    "/nope",
    "/a/b",
    "/a/b/c",
    "/en/x",
    "/sr/x",
    "/wp-admin/install.php?step=1",
  ]) {
    it(`answers 404 for ${pathname}`, async () => {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      await res.body?.cancel();
      expect(res.status, pathname).toBe(404);
    });
  }
});
