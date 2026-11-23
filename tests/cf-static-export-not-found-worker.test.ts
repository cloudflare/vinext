/**
 * A static export (`output: "export"`) deployed to Workers serves its
 * exported files from Static Assets, and requests that match no file fall
 * through to the Worker. Next.js exports only the params `generateStaticParams`
 * lists (it rejects `dynamicParams: true` with `output: "export"`), so every
 * other URL is a 404 there. Here the Worker renders `[locale]/[slug]` for
 * unlisted params, and `notFound()` from `generateMetadata()` answers 200.
 * The Worker admits only the paths the build exported, not what the
 * generators return after the deploy.
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
const TRAILING_SLASH_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-static-export-trailing-slash",
);
const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type ExportWorker = {
  root: string;
  worker: { url: Promise<URL>; dispose(): Promise<void> };
  baseUrl: string;
};

/** Builds and exports a fixture, then runs its Worker in workerd. */
async function startExportWorker(fixtureDir: string, prefix: string): Promise<ExportWorker> {
  const root = await createIsolatedFixture(fixtureDir, prefix, undefined, CLOUDFLARE_NODE_MODULES);
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
  const worker = await wrangler.unstable_startWorker({
    config: path.join(root, "dist/server/wrangler.json"),
    dev: {
      remote: false,
      persist: false,
      logLevel: "none",
      watch: false,
      server: { hostname: "127.0.0.1", port: 0 },
    },
  });
  return { root, worker, baseUrl: (await worker.url).origin };
}

describe("static export on Workers: unmatched URLs", () => {
  let root = "";
  let worker: ExportWorker["worker"] | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ root, worker, baseUrl } = await startExportWorker(FIXTURE_DIR, "vinext-cf-static-export-"));
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

  it("serves the exported paths of a changed generator and an optional catch-all", async () => {
    for (const [pathname, text] of [
      ["/en/feed/old", /Feed (<!-- -->)?old/],
      ["/en/docs/known", /Docs (<!-- -->)?known/],
    ] as const) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status, pathname).toBe(200);
      expect(await res.text(), pathname).toMatch(text);
    }
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
    // Listed by the generator after the build, so never exported.
    "/en/feed/new",
    // An optional catch-all with no segments that the export doesn't list.
    "/en/docs",
  ]) {
    it(`answers 404 for ${pathname}`, async () => {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      await res.body?.cancel();
      expect(res.status, pathname).toBe(404);
    });
  }
});

// Worker-first, so the Worker answers the exported paths too. With
// trailingSlash the request pathname is `/about/`, while the build records
// the exported path as `/about`.
describe("static export on Workers: trailingSlash", () => {
  let root = "";
  let worker: ExportWorker["worker"] | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ root, worker, baseUrl } = await startExportWorker(
      TRAILING_SLASH_FIXTURE_DIR,
      "vinext-cf-static-export-trailing-slash-",
    ));
  }, 240_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("serves an exported dynamic page at its trailing-slash URL", async () => {
    const res = await fetch(`${baseUrl}/about/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Page (<!-- -->)?about/);
  });

  it("answers 404 for an unlisted param", async () => {
    const res = await fetch(`${baseUrl}/nope/`, { redirect: "manual" });
    await res.body?.cancel();
    expect(res.status).toBe(404);
  });
});
