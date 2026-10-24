import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  getImageOptimizer,
  setImageOptimizer,
  type ImageOptimizer,
} from "../packages/vinext/src/server/image-optimization.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const SOURCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

function serverOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe.each(["app", "pages"] as const)(
  "%s Node production configured image optimizer",
  (router) => {
    let fixtureDir: string | undefined;
    let upstream: Server | undefined;
    let server: Server | undefined;
    let baseUrl: string;
    let optimizerKey: string;
    let buildServer: (mode: "configured" | "none" | "throws", outDir: string) => Promise<Server>;
    const upstreamCredentials: boolean[] = [];

    const fixtureOptimizer = () =>
      (globalThis as unknown as Record<symbol, ImageOptimizer>)[Symbol.for(optimizerKey)];

    beforeAll(async () => {
      setImageOptimizer(null);
      upstream = createServer((req, res) => {
        upstreamCredentials.push(Boolean(req.headers.cookie || req.headers.authorization));
        if (req.url?.startsWith("/not-image")) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("not an image");
        } else {
          res.writeHead(req.url === "/missing.png" ? 404 : 200, { "Content-Type": "image/png" });
          res.end(SOURCE_PNG);
        }
      });
      await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
      const upstreamUrl = serverOrigin(upstream);

      fixtureDir = await fs.mkdtemp(
        path.join(import.meta.dirname, `.tmp-${router}-image-optimizer-`),
      );
      optimizerKey = `vinext-test-optimizer:${fixtureDir}`;
      await fs.mkdir(path.join(fixtureDir, router));
      await fs.mkdir(path.join(fixtureDir, "public"));
      await fs.mkdir(path.join(fixtureDir, "node_modules"));
      await fs.symlink(
        path.resolve(import.meta.dirname, "../packages/vinext"),
        path.join(fixtureDir, "node_modules/vinext"),
        "junction",
      );
      await fs.writeFile(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({ name: `vinext-${router}-image-optimizer`, private: true, type: "module" }),
      );
      if (router === "app") {
        await fs.writeFile(
          path.join(fixtureDir, "app/layout.jsx"),
          "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
        );
      }
      const apiDir = path.join(fixtureDir, router, "api", router === "app" ? "image" : "");
      await fs.mkdir(apiDir, { recursive: true });
      await fs.writeFile(
        path.join(apiDir, router === "app" ? "route.js" : "image.js"),
        router === "app"
          ? `export function GET(request) {
              if (request.headers.has("cookie") || request.headers.has("authorization")) {
                return new Response("Expected an anonymous GET", { status: 403 });
              }
              const kind = new URL(request.url).searchParams.get("kind");
              return new Response(kind === "not-image" ? "not an image" : Buffer.from(${JSON.stringify(SOURCE_PNG.toString("base64"))}, "base64"), {
                status: kind === "missing" ? 404 : 200,
                headers: { "Content-Type": kind === "not-image" ? "text/html" : "image/png", "Set-Cookie": "source=private" },
              });
            }\n`
          : `export default function handler(req, res) {
              if (req.method !== "GET" || req.headers.cookie || req.headers.authorization) {
                res.status(403).end("Expected an anonymous GET");
                return;
              }
              const kind = req.query.kind;
              res.status(kind === "missing" ? 404 : 200);
              res.setHeader("Content-Type", kind === "not-image" ? "text/html" : "image/png");
              res.setHeader("Set-Cookie", "source=private");
              res.end(kind === "not-image" ? "not an image" : Buffer.from(${JSON.stringify(SOURCE_PNG.toString("base64"))}, "base64"));
            }\n`,
      );
      await fs.writeFile(
        path.join(fixtureDir, "middleware.js"),
        `import { NextResponse } from "next/server";
         export function middleware(request) {
           if (request.nextUrl.pathname === "/api/image" && request.nextUrl.searchParams.get("kind") === "blocked") {
             return new Response("Image source denied", { status: 403 });
           }
           if (request.nextUrl.pathname === "/_next/image" && request.nextUrl.searchParams.get("dpl") === "staged-middleware") {
             const response = NextResponse.next();
             response.headers.set("Content-Length", "3");
             response.headers.set("X-Image-Header", "middleware");
             return response;
           }
           return NextResponse.next();
         }\n`,
      );
      await fs.writeFile(
        path.join(fixtureDir, router === "app" ? "app/page.jsx" : "pages/index.jsx"),
        "export default function Page() { return <p>image optimizer fixture</p>; }\n",
      );
      await fs.writeFile(path.join(fixtureDir, "public/local.png"), SOURCE_PNG);
      await fs.writeFile(
        path.join(fixtureDir, "next.config.mjs"),
        `export default {
        headers: async () => [{
          source: "/_next/image",
          has: [{ type: "query", key: "dpl", value: "staged-config" }],
          headers: [
            { key: "Content-Length", value: "3" },
            { key: "X-Image-Header", value: "config" },
          ],
        }],
        rewrites: async () => [
          { source: "/media/:path*", destination: ${JSON.stringify(upstreamUrl)} + "/:path*" },
          { source: "/generated-image", destination: "/api/image" },
        ],
      };\n`,
      );
      const adapterPath = path.join(fixtureDir, "image-optimizer.mjs");
      await fs.writeFile(
        adapterPath,
        `export default function createOptimizer() {
        const encode = globalThis.require("./image-encoder.cjs");
        const optimizer = {
          async transformImage(body, { width, format, quality }) {
            const source = Buffer.from(await new Response(body).arrayBuffer());
            return new Response(encode(source), {
              headers: {
                "Content-Type": format,
                "X-Optimizer-Width": String(width),
                "X-Optimizer-Quality": String(quality),
              },
            });
          },
        };
        globalThis[Symbol.for(${JSON.stringify(optimizerKey)})] = optimizer;
        return optimizer;
      }\n`,
      );
      const throwingAdapterPath = path.join(fixtureDir, "throwing-optimizer.mjs");
      await fs.writeFile(
        throwingAdapterPath,
        'export default function() { throw new Error("fixture initialization failed"); }\n',
      );
      buildServer = async (mode, outDir) => {
        const buildRoot = outDir === path.join(fixtureDir!, "dist") ? fixtureDir! : outDir;
        const buildOutDir = path.join(buildRoot, "dist");
        if (buildRoot !== fixtureDir) {
          await fs.mkdir(buildRoot, { recursive: true });
          for (const entry of [
            router,
            "public",
            "package.json",
            "next.config.mjs",
            "middleware.js",
          ]) {
            await fs.cp(path.join(fixtureDir!, entry), path.join(buildRoot, entry), {
              recursive: true,
            });
          }
        }
        const builder = await createBuilder({
          root: buildRoot,
          configFile: false,
          logLevel: "silent",
          plugins: [
            vinext({
              ...(router === "app" ? { appDir: buildRoot } : { disableAppRouter: true }),
              rscOutDir: path.join(buildOutDir, "server"),
              ssrOutDir: path.join(buildOutDir, "server/ssr"),
              clientOutDir: path.join(buildOutDir, "client"),
              images:
                mode === "none"
                  ? undefined
                  : {
                      optimizer: { adapter: mode === "throws" ? throwingAdapterPath : adapterPath },
                    },
            }),
          ],
        });
        await builder.buildApp();
        // Adapter initialization must resolve CommonJS dependencies relative to
        // the built server entry, just like its request handlers do.
        await fs.writeFile(
          path.join(buildOutDir, "server/image-encoder.cjs"),
          'module.exports = (source) => "transformed:" + source.toString("base64");\n',
        );
        return (await startProdServer({ port: 0, host: "127.0.0.1", outDir: buildOutDir })).server;
      };
      server = await buildServer("configured", path.join(fixtureDir, "dist"));
      baseUrl = serverOrigin(server);
    }, 120000);

    afterAll(async () => {
      await closeServer(server);
      await closeServer(upstream);
      setImageOptimizer(null);
      Reflect.deleteProperty(globalThis, Symbol.for(optimizerKey));
      if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    it("uses the configured optimizer for a public image", async () => {
      const response = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        headers: { Accept: "image/webp" },
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("x-optimizer-width")).toBe("64");
      expect(response.headers.get("x-optimizer-quality")).toBe("75");
      expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);

      const head = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");

      const post = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        method: "POST",
      });
      await post.arrayBuffer();
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    });

    // Next.js derives image Content-Length from the transformed bytes:
    // https://github.com/vercel/next.js/blob/7657545d157a04c3b21112f08e4675a4ebffeb5a/packages/next/src/server/image-optimizer.ts#L1173-L1187
    // App's image signal currently forwards only middleware headers.
    it.each(
      ["/local.png", "/media/banner.png", "/api/image", "/generated-image"].flatMap((source) =>
        (router === "pages" ? ["config", "middleware"] : ["middleware"]).map((staging) => ({
          source,
          staging,
        })),
      ),
    )(
      "does not truncate optimized source $source with $staging content length",
      async ({ source, staging }) => {
        // dpl is an accepted optimizer query parameter. Keep these staged
        // headers on the endpoint request, never its anonymous source GET.
        const response = await fetch(
          `${baseUrl}/_next/image?url=${encodeURIComponent(source)}&w=64&q=75&dpl=staged-${staging}`,
          { headers: { Accept: "image/webp", Connection: "close" } },
        );
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(response.headers.get("x-image-header")).toBe(staging);
        expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
        expect(response.headers.get("content-length")).not.toBe("3");
      },
    );

    // Ported from Next.js: test/e2e/image-optimizer/image-optimizer.test.ts
    // https://github.com/vercel/next.js/blob/7657545d157a04c3b21112f08e4675a4ebffeb5a/test/e2e/image-optimizer/image-optimizer.test.ts#L444
    it.each(["banner.png", "banner", "banner.bin"])(
      "optimizes external rewrite source %s using its response content type",
      async (source) => {
        const direct = await fetch(`${baseUrl}/media/${source}`);
        const directBody = Buffer.from(await direct.arrayBuffer());
        expect(direct.status).toBe(200);
        expect(directBody).toEqual(SOURCE_PNG);

        upstreamCredentials.length = 0;
        const response = await fetch(
          `${baseUrl}/_next/image?url=${encodeURIComponent(`/media/${source}`)}&w=64&q=75`,
          {
            headers: {
              Accept: "image/webp",
              Cookie: "fixture=caller",
              Authorization: "Bearer fixture",
            },
          },
        );
        const body = await response.text();

        expect(response.status, body).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
        expect(upstreamCredentials).toEqual([false]);
      },
    );

    // Next.js fetchInternalImage dispatches anonymous source requests through
    // the full router, including APIs: packages/next/src/server/image-optimizer.ts.
    // https://github.com/vercel/next.js/blob/7657545d157a04c3b21112f08e4675a4ebffeb5a/packages/next/src/server/image-optimizer.ts#L938
    it.each(["/api/image", "/generated-image"])(
      "optimizes API image source %s through an anonymous GET",
      async (source) => {
        const direct = await fetch(`${baseUrl}${source}`);
        expect(direct.status).toBe(200);
        expect(Buffer.from(await direct.arrayBuffer())).toEqual(SOURCE_PNG);

        const response = await fetch(
          `${baseUrl}/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`,
          {
            headers: {
              Accept: "image/webp",
              Cookie: "caller=private",
              Authorization: "Bearer caller",
            },
          },
        );
        const body = await response.text();
        expect(response.status, body).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/webp");
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(body).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
      },
    );

    it("rejects denied, unsuccessful and non-image API sources before transformation", async () => {
      const optimizer = fixtureOptimizer();
      expect(optimizer).not.toBeNull();
      const transform = vi.spyOn(optimizer!, "transformImage");
      try {
        const denied = await fetch(`${baseUrl}/api/image?kind=blocked`);
        expect(denied.status).toBe(403);
        await denied.text();
        for (const kind of ["blocked", "missing", "not-image"]) {
          const response = await fetch(
            `${baseUrl}/_next/image?url=${encodeURIComponent(`/api/image?kind=${kind}`)}&w=64&q=75`,
          );
          const body = await response.text();
          expect(response.status, kind).toBe(400);
          expect(body).not.toContain("transformed:");
        }
        expect(transform).not.toHaveBeenCalled();
      } finally {
        transform.mockRestore();
      }
    });

    it("rejects unsuccessful and non-image rewrite sources before transformation", async () => {
      const optimizer = fixtureOptimizer();
      expect(optimizer).not.toBeNull();
      const transform = vi.spyOn(optimizer!, "transformImage");
      try {
        for (const source of ["missing.png", "not-image.png", "not-image", "not-image.bin"]) {
          const response = await fetch(
            `${baseUrl}/_next/image?url=${encodeURIComponent(`/media/${source}`)}&w=64&q=75`,
          );
          const body = await response.text();

          expect(response.status, source).toBe(400);
          expect(response.headers.has("x-optimizer-width")).toBe(false);
          expect(body).not.toContain("transformed:");
        }
        expect(transform).not.toHaveBeenCalled();
      } finally {
        transform.mockRestore();
      }
    });

    it.each(["none", "throws"] as const)(
      "does not inherit a previous server optimizer when the new adapter is %s",
      async (mode) => {
        const other = await buildServer(mode, path.join(fixtureDir!, `dist-${mode}`));
        try {
          const response = await fetch(
            `${serverOrigin(other)}/_next/image?url=%2Flocal.png&w=64&q=75`,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/png");
          expect(Buffer.from(await response.arrayBuffer())).toEqual(SOURCE_PNG);
          const original = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
            headers: { Accept: "image/webp" },
          });
          expect(await original.text()).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
        } finally {
          await closeServer(other);
        }
      },
      120000,
    );

    it("keeps the configured optimizer when starting the same entry again", async () => {
      const { server: other } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(fixtureDir!, "dist"),
      });
      try {
        const response = await fetch(
          `${serverOrigin(other)}/_next/image?url=%2Flocal.png&w=64&q=75`,
          { headers: { Accept: "image/webp" } },
        );
        expect(await response.text()).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
      } finally {
        await closeServer(other);
      }
    });

    it("preserves an imperative default for a server without configured images", async () => {
      const previous = getImageOptimizer();
      setImageOptimizer({
        transformImage: async () =>
          new Response("manual image", { headers: { "Content-Type": "image/webp" } }),
      });
      let other: Server | undefined;
      try {
        other = await buildServer("none", path.join(fixtureDir!, "dist-manual"));
        const response = await fetch(
          `${serverOrigin(other)}/_next/image?url=%2Flocal.png&w=64&q=75`,
          { headers: { Accept: "image/webp" } },
        );
        expect(await response.text()).toBe("manual image");
      } finally {
        await closeServer(other);
        setImageOptimizer(previous);
      }
    }, 120000);

    it("passes through public and rewrite images when no optimizer is active", async () => {
      const configuredOptimizer = fixtureOptimizer();
      setImageOptimizer(null);
      try {
        for (const source of [
          "/local.png",
          "/media/banner.png",
          "/media/banner",
          "/media/banner.bin",
          "/api/image",
          "/generated-image",
        ]) {
          const response = await fetch(
            `${baseUrl}/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`,
            { headers: { Accept: "image/webp" } },
          );
          const body = Buffer.from(await response.arrayBuffer());

          expect(response.status, source).toBe(200);
          expect(response.headers.get("content-type")).toBe("image/png");
          expect(body).toEqual(SOURCE_PNG);
        }
      } finally {
        setImageOptimizer(configuredOptimizer);
      }
      const restored = await fetch(`${baseUrl}/_next/image?url=%2Flocal.png&w=64&q=75`, {
        headers: { Accept: "image/webp" },
      });
      expect(await restored.text()).toBe(`transformed:${SOURCE_PNG.toString("base64")}`);
    });
  },
);
