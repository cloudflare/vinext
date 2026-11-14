import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { createBuilder, preview, type PreviewServer } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const MARKER = "<!--VINEXT_PRERENDER_MARKER-->";

// `next start` serves prerendered Pages output from `.next/server/pages/<route>.html`
// from the first request, and dates it with the file's mtime, so `revalidate`
// counts from the build (server/lib/incremental-cache/file-system-cache.ts).
describe.each([
  { name: "Pages Router", fixture: "pages-prerender-node-serve", hybrid: false },
  {
    name: "hybrid App and Pages Router",
    fixture: "pages-prerender-node-serve-hybrid",
    hybrid: true,
  },
  // Too small to keep any page: each is served from its file on every request,
  // as Next.js's FileSystemCache returns what it read.
  {
    name: "Pages Router with a 1-byte cacheMaxMemorySize",
    fixture: "pages-prerender-node-serve",
    hybrid: false,
    nextConfig: { cacheMaxMemorySize: 1 },
  },
  {
    name: "Pages Router under vite preview",
    fixture: "pages-prerender-node-serve",
    hybrid: false,
    viaPreview: true,
  },
  {
    name: "hybrid App and Pages Router under vite preview",
    fixture: "pages-prerender-node-serve-hybrid",
    hybrid: true,
    viaPreview: true,
  },
])(
  "$name: prerendered Pages routes on the Node production server",
  ({ fixture, hybrid, nextConfig, viaPreview }) => {
    let root: string;
    let server: http.Server | undefined;
    let previewServer: PreviewServer | undefined;
    let baseUrl: string;

    beforeAll(async () => {
      root = await createIsolatedFixture(
        path.resolve(import.meta.dirname, "fixtures", fixture),
        "vinext-pages-prerender-node-",
      );
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          vinext({ ...(hybrid ? { appDir: root } : { disableAppRouter: true }), nextConfig }),
        ],
      });
      await builder.buildApp();
      // The prerender step `vite build` runs for `vinext({ prerender: true })`.
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
      await runPrerender({
        root,
        ...(hybrid ? {} : { pagesBundlePath: path.join(root, "dist", "server", "entry.js") }),
        concurrency: 1,
      });

      const serverDir = path.join(root, "dist", "server");
      const manifest = JSON.parse(
        await fs.readFile(path.join(serverDir, "vinext-prerender.json"), "utf-8"),
      ) as { routes: Array<{ route: string; status: string; router?: string }> };
      for (const route of ["/static", "/isr", "/stale"]) {
        expect(manifest.routes).toContainEqual(
          expect.objectContaining({ route, status: "rendered", router: "pages" }),
        );
        const file = path.join(serverDir, "prerendered-routes", `${route.slice(1)}.html`);
        const html = await fs.readFile(file, "utf-8");
        await fs.writeFile(file, html.replace("</body>", `${MARKER}</body>`));
      }
      // Built half an hour ago: past `/stale`'s 60 s revalidate, within `/isr`'s hour.
      const builtAt = new Date(Date.now() - 30 * 60 * 1000);
      for (const route of ["/isr", "/stale"]) {
        const file = path.join(serverDir, "prerendered-routes", `${route.slice(1)}.html`);
        await fs.utimes(file, builtAt, builtAt);
      }

      // The prerender ran in this process and left its own memory cache
      // installed. A `vinext start` process has the one its server entry
      // configures from next.config.
      const { configureMemoryCacheHandler } =
        await import("../packages/vinext/src/shims/cache-handler.js");
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("vinext.cacheHandler")];
      configureMemoryCacheHandler({ cacheMaxMemorySize: nextConfig?.cacheMaxMemorySize });

      let address: ReturnType<http.Server["address"]>;
      if (viaPreview) {
        previewServer = await preview({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [
            vinext({ ...(hybrid ? { appDir: root } : { disableAppRouter: true }), nextConfig }),
          ],
          preview: { host: "127.0.0.1", port: 0 },
        });
        address = previewServer.httpServer.address();
      } else {
        const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
        const started = await startProdServer({
          host: "127.0.0.1",
          port: 0,
          outDir: path.join(root, "dist"),
          noCompression: true,
        });
        server = started.server;
        address = server.address();
      }
      if (!address || typeof address === "string")
        throw new Error("Production server did not bind");
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await previewServer?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("serves an automatically static page from its prerendered HTML", async () => {
      const response = await fetch(`${baseUrl}/static`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(MARKER);
    });

    it("serves a getStaticProps page from its prerendered HTML on the first request", async () => {
      const response = await fetch(`${baseUrl}/isr`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect({
        cache: response.headers.get("x-vinext-cache"),
        hasMarker: html.includes(MARKER),
      }).toEqual({ cache: "HIT", hasMarker: true });
    });

    it("counts revalidate from the prerendered file's mtime", async () => {
      const response = await fetch(`${baseUrl}/stale`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect({
        cache: response.headers.get("x-vinext-cache"),
        hasMarker: html.includes(MARKER),
      }).toEqual({ cache: "STALE", hasMarker: true });
    });

    // Regeneration replaces the stale build artifact; it is never served again,
    // even when memory is too small to keep the regenerated page.
    it("serves the regenerated page once a stale artifact has regenerated", async () => {
      await expect
        .poll(
          async () => {
            const response = await fetch(`${baseUrl}/stale`);
            return (await response.text()).includes(MARKER);
          },
          { timeout: 10_000, interval: 100 },
        )
        .toBe(false);
      const response = await fetch(`${baseUrl}/stale`);
      const html = await response.text();
      expect({
        stale: response.headers.get("x-vinext-cache") === "STALE",
        hasMarker: html.includes(MARKER),
      }).toEqual({ stale: false, hasMarker: false });
    });
  },
);
