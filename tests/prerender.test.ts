/**
 * Prerender phase tests.
 *
 * Tests assert the **structural output** of prerendering — which routes were
 * rendered, which were skipped, which errored, and what files were produced.
 * Tests do NOT assert on raw HTML content (that belongs to E2E/Playwright).
 *
 * Both `prerenderPages()` and `prerenderApp()` are tested against the
 * `pages-basic` and `app-basic` fixtures respectively.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildPagesFixture,
  buildAppFixture,
  buildCloudflareAppFixture,
  createIsolatedFixture,
} from "./helpers.js";
import {
  extractRscPayloadFromPrerenderedHtml,
  resolveParentParams,
  routeStaticParamSets,
  writePrerenderIndex,
  type PrerenderRouteResult,
  type StaticParamsMap,
} from "../packages/vinext/src/build/prerender.js";
import { handleAppPrerenderEndpoint } from "../packages/vinext/src/server/app-prerender-endpoints.js";
import { createAppPrerenderStaticParamsResolver } from "../packages/vinext/src/server/app-prerender-static-params.js";
import {
  VINEXT_PRERENDER_SPECIAL_ERROR_HEADER,
  VINEXT_PRERENDER_SPECULATIVE_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { safeJsonStringify } from "../packages/vinext/src/server/html.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import {
  getAppRouteOutputPath,
  getOutputPath,
  getRscOutputPath,
} from "../packages/vinext/src/utils/prerender-output-paths.js";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");
const CF_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");

// ─── Helper ──────────────────────────────────────────────────────────────────

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findRoute(
  results: PrerenderRouteResult[],
  route: string,
): PrerenderRouteResult | undefined {
  return results.find((r) => r.route === route || ("path" in r && r.path === route));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
      } else {
        reject(new Error("test server did not expose a TCP port"));
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const RSC_RUNTIME_BOOTSTRAP_EXPRESSION =
  '((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]})';

function runtimeRscChunkScript(chunk: string | [3, string]): string {
  return `<script>${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.rsc.push(${safeJsonStringify(chunk)})</script>`;
}

function runtimeRscDoneScript(): string {
  return `<script>${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.done=true</script>`;
}

function runtimeRscDoneScriptWithCacheMetadata(): string {
  return `<script>Object.assign(${RSC_RUNTIME_BOOTSTRAP_EXPRESSION},{"initialCacheKind":"static"});${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.done=true</script>`;
}

function legacyRscChunkScript(chunk: string | [3, string]): string {
  return (
    "<script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];" +
    `self.__VINEXT_RSC_CHUNKS__.push(${safeJsonStringify(chunk)})</script>`
  );
}

function legacyRscDoneScript(): string {
  return "<script>self.__VINEXT_RSC_DONE__=true</script>";
}

// ─── App Router RSC payload extraction ───────────────────────────────────────

describe("getRscOutputPath", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/static-export-skew-trailing-slash/static-export-skew-trailing-slash.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-export-skew-trailing-slash/static-export-skew-trailing-slash.test.ts
  it("matches static export HTML layout with text/plain Flight artifacts", () => {
    expect(getRscOutputPath("/", { mode: "export", trailingSlash: true })).toBe("index.txt");
    expect(getRscOutputPath("/target", { mode: "export", trailingSlash: true })).toBe(
      "target/index.txt",
    );
    expect(getRscOutputPath("/target", { mode: "export", trailingSlash: false })).toBe(
      "target.txt",
    );
    expect(
      getRscOutputPath("/", {
        mode: "export",
        trailingSlash: false,
        basePath: "/docs",
      }),
    ).toBe("docs/index.txt");
    expect(
      getRscOutputPath("/target", {
        mode: "export",
        trailingSlash: false,
        basePath: "/docs",
      }),
    ).toBe("docs/target.txt");
  });

  it("retains .rsc files for server prerenders", () => {
    expect(getRscOutputPath("/")).toBe("index.rsc");
    expect(getRscOutputPath("/target")).toBe("target.rsc");
  });
});

describe("getOutputPath", () => {
  it("emits canonical basePath keys for both trailingSlash modes", () => {
    expect(getOutputPath("/", false, "/docs")).toBe("docs.html");
    expect(getOutputPath("/", true, "/docs")).toBe("docs/index.html");
    expect(getOutputPath("/about", false, "/docs")).toBe("docs/about.html");
    expect(getOutputPath("/about", true, "/docs")).toBe("docs/about/index.html");
  });
});

describe("extractRscPayloadFromPrerenderedHtml", () => {
  function decodeExtractedPayload(html: string): string | null {
    const payload = extractRscPayloadFromPrerenderedHtml(html);
    return payload === null ? null : new TextDecoder().decode(payload);
  }

  it("reconstructs streamed RSC chunks from inline bootstrap scripts", () => {
    const chunks = [
      '0:D{"name":"layout"}\n',
      '1:["$","div",null,{"children":"hello ) world"}]\n',
      '2:["$","span",null,{"children":"</script><script>alert(1)</script>"}]\n',
    ];
    const html =
      "<html><body>" +
      chunks.map((chunk) => runtimeRscChunkScript(chunk)).join("") +
      runtimeRscDoneScript() +
      "</body></html>";

    expect(decodeExtractedPayload(html)).toBe(chunks.join(""));
  });

  it("reconstructs chunks when cache metadata precedes the done marker", () => {
    const html =
      "<html><body>" +
      runtimeRscChunkScript("0:[]\n") +
      runtimeRscDoneScriptWithCacheMetadata() +
      "</body></html>";

    expect(decodeExtractedPayload(html)).toBe("0:[]\n");
  });

  it("keeps parsing legacy streamed RSC chunk scripts", () => {
    const chunks = ['0:D{"name":"layout"}\n', '1:["$","div",null,{"children":"legacy"}]\n'];
    const html =
      "<html><body>" +
      chunks.map((chunk) => legacyRscChunkScript(chunk)).join("") +
      legacyRscDoneScript() +
      "</body></html>";

    expect(decodeExtractedPayload(html)).toBe(chunks.join(""));
  });

  it("reconstructs binary RSC chunks from inline bootstrap scripts", () => {
    // Ported from Next.js: test/e2e/app-dir/binary/rsc-binary.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/binary/rsc-binary.test.ts
    const html =
      "<html><body>" +
      runtimeRscChunkScript("0:text\n") +
      runtimeRscChunkScript([3, "/wABAgM="]) +
      runtimeRscDoneScript() +
      "</body></html>";

    const payload = extractRscPayloadFromPrerenderedHtml(html);

    expect(payload).toEqual(
      new Uint8Array([...new TextEncoder().encode("0:text\n"), 255, 0, 1, 2, 3]),
    );
  });

  it("throws when the done marker is missing", () => {
    const html = "<html><body>" + runtimeRscChunkScript("0:[]\n") + "</body></html>";

    expect(() => extractRscPayloadFromPrerenderedHtml(html)).toThrow(/missing RSC done marker/);
  });

  it("does not treat marker-looking RSC payload text as the done control script", () => {
    const html =
      "<html><body>" + runtimeRscChunkScript('0:["__VINEXT_RSC_DONE__=true"]\n') + "</body></html>";

    expect(() => extractRscPayloadFromPrerenderedHtml(html)).toThrow(/missing RSC done marker/);
  });

  it("ignores non-chunk runtime scripts that start with the bootstrap expression", () => {
    const html =
      "<html><body>" +
      `<script>${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.metadata={}</script>` +
      runtimeRscChunkScript("0:[]\n") +
      runtimeRscDoneScript() +
      "</body></html>";

    expect(decodeExtractedPayload(html)).toBe("0:[]\n");
  });

  it("rejects chunk scripts with trailing code after the payload push", () => {
    const html =
      "<html><body>" +
      `<script>${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.rsc.push(${safeJsonStringify("0:[]\n")})alert(1)</script>` +
      runtimeRscDoneScript() +
      "</body></html>";

    // JSON.parse rejects the slice (which includes the `)` and `alert(1` after
    // the JSON-encoded string), so this is reported as malformed JSON rather
    // than a separate "trailing code" diagnostic.
    expect(() => extractRscPayloadFromPrerenderedHtml(html)).toThrow(
      "[vinext] Malformed prerender RSC embed: invalid chunk JSON",
    );
  });

  it("rejects chunk scripts with invalid JSON", () => {
    const html =
      "<html><body>" +
      `<script>${RSC_RUNTIME_BOOTSTRAP_EXPRESSION}.rsc.push("\\uZZZZ")</script>` +
      runtimeRscDoneScript() +
      "</body></html>";

    expect(() => extractRscPayloadFromPrerenderedHtml(html)).toThrow(
      "[vinext] Malformed prerender RSC embed: invalid chunk JSON",
    );
  });

  it("returns null when no chunk scripts and no done marker are present (middleware short-circuit)", () => {
    // Middleware that returns a custom 200 HTML body bypasses the App Router
    // pipeline entirely — no chunks, no done marker. The driver detects this
    // null and falls back to a second invocation with `RSC: 1`.
    expect(extractRscPayloadFromPrerenderedHtml("<html><body>legacy</body></html>")).toBeNull();
  });

  it("throws when only the done marker is present without any chunks", () => {
    // Half-emitted embed (done marker but no chunks) is a real bug — partial
    // emission shouldn't fall back silently.
    const html = `<html><body>${runtimeRscDoneScript()}</body></html>`;

    expect(() => extractRscPayloadFromPrerenderedHtml(html)).toThrow(
      "[vinext] Malformed prerender RSC embed: done marker present without chunk scripts",
    );
  });
});

describe("prerenderApp — RSC extraction", () => {
  it("requests App pages through basePath and writes basePath-prefixed export artifacts", async () => {
    const root = tmpDir("vinext-prerender-app-basepath-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "page.tsx"),
      "export const dynamic = 'force-static';\nexport default function Page() { return null; }\n",
    );

    const requestedPaths: string[] = [];
    const rscPayload = '0:["$","main",null,{"children":"basePath page"}]\n';
    const server = createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.url !== "/docs") {
        res.statusCode = 404;
        res.end("<html>not found</html>");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(rscPayload) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({ basePath: "/docs" });

      const result = await prerenderApp({
        mode: "export",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(requestedPaths).toContain("/docs");
      expect(requestedPaths).not.toContain("/");
      expect(findRoute(result.routes, "/")).toMatchObject({
        route: "/",
        status: "rendered",
      });
      expect(fs.readFileSync(path.join(outDir, "docs.html"), "utf8")).toContain("<html><body>");
      expect(fs.readFileSync(path.join(outDir, "docs", "index.txt"), "utf8")).toBe(rscPayload);
      expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(false);
      expect(fs.existsSync(path.join(outDir, "index.txt"))).toBe(false);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests metadata routes through basePath while writing basePath-free artifacts", async () => {
    const root = tmpDir("vinext-prerender-metadata-basepath-");
    const outDir = path.join(root, "out");
    const requestedPaths: string[] = [];
    const server = createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.url === "/__vinext/prerender/metadata-routes") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify([{ path: "/robots.txt", routePattern: "/robots.txt", routeSegments: [] }]),
        );
        return;
      }
      if (req.url === "/docs/robots.txt") {
        res.setHeader("content-type", "text/plain");
        res.setHeader("cache-control", "public, max-age=0, must-revalidate");
        res.setHeader("x-next-cache-tags", "metadata-user-tag");
        res.setHeader("x-vinext-prerender-cache-life", '{"revalidate":900}');
        res.end("User-Agent: *\nAllow: /buildtime\n");
        return;
      }
      res.statusCode = 404;
      res.end("<html>not found</html>");
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const config = await resolveNextConfig({ basePath: "/docs" });
      const result = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes: [],
        metadataRoutes: [
          {
            type: "robots",
            isDynamic: true,
            filePath: path.join(root, "app", "robots.ts"),
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/robots.txt",
            contentType: "text/plain",
          },
        ],
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(requestedPaths).toContain("/docs/robots.txt");
      expect(requestedPaths).not.toContain("/robots.txt");
      const metadataResult = findRoute(result.routes, "/robots.txt");
      expect(metadataResult).toMatchObject({
        status: "rendered",
        router: "metadata",
        tags: ["metadata-user-tag"],
      });
      if (metadataResult?.status === "rendered") {
        expect(metadataResult.headers?.["x-next-cache-tags"]).toBeUndefined();
      }
      expect(fs.readFileSync(path.join(outDir, "robots.txt.route"), "utf8")).toContain(
        "/buildtime",
      );
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([0, 60])(
    "uses metadata framework revalidate=%s independently of browser no-store",
    async (revalidate) => {
      const root = tmpDir("vinext-prerender-metadata-cache-admission-");
      const outDir = path.join(root, "out");
      const server = createServer((req, res) => {
        if (req.url === "/__vinext/prerender/metadata-routes") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify([
              {
                path: "/manifest.webmanifest",
                routePattern: "/manifest.webmanifest",
                routeSegments: [],
              },
              { path: "/icon", routePattern: "/icon", routeSegments: [] },
            ]),
          );
          return;
        }
        if (req.url === "/manifest.webmanifest") {
          res.setHeader("content-type", "application/manifest+json");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("x-vinext-prerender-cache-life", JSON.stringify({ revalidate }));
          res.end('{"name":"runtime"}');
          return;
        }
        if (req.url === "/icon") {
          res.setHeader("content-type", "image/png");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-vinext-prerender-cache-life", JSON.stringify({ revalidate }));
          res.end("runtime image");
          return;
        }
        res.statusCode = 404;
        res.end("<html>not found</html>");
      });

      const port = await listen(server);
      try {
        const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
        const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
        const config = await resolveNextConfig({});
        const result = await prerenderApp({
          mode: "default",
          rscBundlePath: path.join(root, "dist", "server", "index.js"),
          routes: [],
          metadataRoutes: [
            {
              type: "manifest",
              isDynamic: true,
              filePath: path.join(root, "app", "manifest.ts"),
              routePrefix: "",
              routeSegments: [],
              servedUrl: "/manifest.webmanifest",
              contentType: "application/manifest+json",
            },
            {
              type: "icon",
              isDynamic: true,
              filePath: path.join(root, "app", "icon.tsx"),
              routePrefix: "",
              routeSegments: [],
              servedUrl: "/icon",
              contentType: "image/png",
            },
          ],
          outDir,
          config,
          _prodServer: { server, port },
        });

        for (const route of ["/manifest.webmanifest", "/icon"]) {
          expect(findRoute(result.routes, route)).toMatchObject(
            revalidate === 0 ? { status: "skipped", reason: "dynamic" } : { status: "rendered" },
          );
          expect(fs.existsSync(path.join(outDir, `${route.slice(1)}.route`))).toBe(revalidate > 0);
        }
      } finally {
        await closeServer(server);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("writes the .rsc file from rendered HTML without a second RSC request", async () => {
    const root = tmpDir("vinext-prerender-rsc-dedupe-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pagePath = path.join(appDir, "page.tsx");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      pagePath,
      "export const dynamic = 'force-static';\nexport default function Page() { return null; }\n",
    );

    const rscPayload = '0:["$","div",null,{"children":"from html"}]\n';
    let rscRequestCount = 0;
    const server = createServer((req, res) => {
      if (req.headers.rsc === "1" || req.headers.accept === "text/x-component") {
        rscRequestCount++;
        res.statusCode = 500;
        res.end("unexpected RSC request");
        return;
      }

      if (req.url === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }

      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(rscPayload) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const prerenderResult = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(findRoute(prerenderResult.routes, "/")).toMatchObject({
        route: "/",
        status: "rendered",
      });
      expect(fs.readFileSync(path.join(outDir, "index.rsc"), "utf-8")).toBe(rscPayload);
      expect(rscRequestCount).toBe(0);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a second RSC: 1 invocation when middleware short-circuits with custom HTML", async () => {
    // Middleware that returns a 200 HTML body bypasses the App Router
    // pipeline — the response contains no embed chunks. The driver must
    // recover by issuing a second invocation with `RSC: 1` and use whatever
    // that returns as the .rsc file.
    const root = tmpDir("vinext-prerender-rsc-fallback-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pagePath = path.join(appDir, "page.tsx");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      pagePath,
      "export const dynamic = 'force-static';\nexport default function Page() { return null; }\n",
    );

    const middlewareHtml = "<html><body>middleware short-circuit</body></html>";
    const fallbackRscPayload = '0:["$","div",null,{"children":"from fallback"}]\n';
    let pageRequestCount = 0;
    let rscRequestCount = 0;
    const server = createServer((req, res) => {
      const isRsc = req.headers.rsc === "1" || req.headers.accept === "text/x-component";

      if (req.url === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }

      if (isRsc) {
        rscRequestCount++;
        res.setHeader("content-type", "text/x-component");
        res.end(fallbackRscPayload);
        return;
      }

      // Page request: middleware short-circuits with plain HTML and no
      // RSC embed chunks — exercising the fallback path.
      pageRequestCount++;
      res.setHeader("content-type", "text/html");
      res.end(middlewareHtml);
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const prerenderResult = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(findRoute(prerenderResult.routes, "/")).toMatchObject({
        route: "/",
        status: "rendered",
      });

      // HTML on disk is the middleware response.
      expect(fs.readFileSync(path.join(outDir, "index.html"), "utf-8")).toBe(middlewareHtml);
      // .rsc on disk is the fallback RSC: 1 response.
      expect(fs.readFileSync(path.join(outDir, "index.rsc"), "utf-8")).toBe(fallbackRscPayload);

      // Exactly one page request and one RSC fallback request per route.
      expect(pageRequestCount).toBe(1);
      expect(rscRequestCount).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the speculative prerender marker on fallback RSC requests", async () => {
    const root = tmpDir("vinext-prerender-rsc-speculative-fallback-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pagePath = path.join(appDir, "page.tsx");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(pagePath, "export default function Page() { return null; }\n");

    const middlewareHtml = "<html><body>middleware short-circuit</body></html>";
    const fallbackRscPayload = '0:["$","div",null,{"children":"from fallback"}]\n';
    const seenSpeculativeHeaders: Array<string | string[] | undefined> = [];
    const server = createServer((req, res) => {
      const isRsc = req.headers.rsc === "1" || req.headers.accept === "text/x-component";

      if (req.url === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }

      seenSpeculativeHeaders.push(req.headers[VINEXT_PRERENDER_SPECULATIVE_HEADER]);
      if (isRsc) {
        res.setHeader("content-type", "text/x-component");
        res.end(fallbackRscPayload);
        return;
      }

      res.setHeader("content-type", "text/html");
      res.end(middlewareHtml);
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const prerenderResult = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(findRoute(prerenderResult.routes, "/")).toMatchObject({
        route: "/",
        status: "rendered",
      });
      expect(fs.readFileSync(path.join(outDir, "index.rsc"), "utf-8")).toBe(fallbackRscPayload);
      expect(seenSpeculativeHeaders).toEqual(["1", "1"]);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("errors without writing .rsc when the middleware short-circuit fallback RSC request fails", async () => {
    const root = tmpDir("vinext-prerender-rsc-fallback-failure-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pagePath = path.join(appDir, "page.tsx");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      pagePath,
      "export const dynamic = 'force-static';\nexport default function Page() { return null; }\n",
    );

    const middlewareHtml = "<html><body>middleware short-circuit</body></html>";
    let pageRequestCount = 0;
    let rscRequestCount = 0;
    const server = createServer((req, res) => {
      const isRsc = req.headers.rsc === "1" || req.headers.accept === "text/x-component";

      if (req.url === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }

      if (isRsc) {
        rscRequestCount++;
        res.statusCode = 500;
        res.end("fallback failed");
        return;
      }

      pageRequestCount++;
      res.setHeader("content-type", "text/html");
      res.end(middlewareHtml);
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const prerenderResult = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      const route = findRoute(prerenderResult.routes, "/");
      expect(route).toMatchObject({
        route: "/",
        status: "error",
      });
      if (route?.status !== "error") throw new Error("expected route to fail prerender");
      expect(route.error).toContain("[vinext] prerenderApp: RSC fallback returned 500 for /");
      expect(fs.existsSync(path.join(outDir, "index.rsc"))).toBe(false);
      expect(pageRequestCount).toBe(1);
      expect(rscRequestCount).toBe(1);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// As in Next.js's build, a page whose notFound(), forbidden(), unauthorized()
// or redirect() escapes the shell is written with its status and location.
describe("prerenderApp — special errors that escape the shell", () => {
  async function prerenderSpecialErrorPage(
    respond: (res: import("node:http").ServerResponse, isRsc: boolean) => void,
  ) {
    const root = tmpDir("vinext-prerender-special-error-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "page.tsx"),
      "export const revalidate = 60;\nexport default function Page() { return null; }\n",
    );
    const server = createServer((req, res) => {
      if (req.url === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }
      respond(res, req.headers.rsc === "1");
    });
    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const result = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes: await appRouter(appDir),
        outDir,
        config: await resolveNextConfig({}),
        _prodServer: { server, port },
      });
      const read = (file: string) =>
        fs.existsSync(path.join(outDir, file))
          ? fs.readFileSync(path.join(outDir, file), "utf8")
          : null;
      return {
        html: read("index.html"),
        route: findRoute(result.routes, "/"),
        rsc: read("index.rsc"),
      };
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // The document embeds its boundary's payload; the page's own RSC payload,
  // with the digest, is what an RSC request gets.
  const boundaryDocument =
    "<html><body>not found" +
    runtimeRscChunkScript('0:["$","p",null,{"children":"boundary"}]\n') +
    runtimeRscDoneScript() +
    "</body></html>";
  const pagePayload = '0:["$","p",null,{"children":"page with digest"}]\n';

  // The marker carries the redirect's own location, as runtime ISR stores it,
  // not the response's, which middleware may have replaced.
  it.each([
    { status: 404, location: undefined },
    { status: 403, location: undefined },
    { status: 401, location: undefined },
    { status: 307, location: "/target" },
  ])("writes the $status document and the page's RSC payload", async ({ status, location }) => {
    const { html, route, rsc } = await prerenderSpecialErrorPage((res, isRsc) => {
      if (isRsc) {
        res.setHeader("content-type", "text/x-component");
        res.end(pagePayload);
        return;
      }
      res.statusCode = status;
      res.setHeader("content-type", "text/html");
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate");
      res.setHeader(
        VINEXT_PRERENDER_SPECIAL_ERROR_HEADER,
        JSON.stringify(location ? { location } : {}),
      );
      res.setHeader("location", "/middleware-location");
      res.end(location ? "" : boundaryDocument);
    });

    expect(route).toMatchObject({
      status: "rendered",
      responseStatus: status,
      revalidate: 60,
    });
    if (route?.status !== "rendered") throw new Error("expected the page to render");
    expect(route.headers?.location).toBe(location);
    expect(html).toBe(location ? "" : boundaryDocument);
    expect(rsc).toBe(pagePayload);
  });

  // As runtime ISR does, a redirect("") keeps its empty location.
  it("writes a redirect to an empty location", async () => {
    const { route } = await prerenderSpecialErrorPage((res, isRsc) => {
      if (isRsc) {
        res.setHeader("content-type", "text/x-component");
        res.end(pagePayload);
        return;
      }
      res.statusCode = 307;
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate");
      res.setHeader(VINEXT_PRERENDER_SPECIAL_ERROR_HEADER, JSON.stringify({ location: "" }));
      res.end("");
    });

    expect(route).toMatchObject({ responseStatus: 307, headers: { location: "" } });
  });

  it("still fails a 404 that isn't its page's special error", async () => {
    const { html, route, rsc } = await prerenderSpecialErrorPage((res) => {
      res.statusCode = 404;
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate");
      res.end(boundaryDocument);
    });

    expect(route).toMatchObject({ status: "error", error: "RSC handler returned 404" });
    expect(html).toBeNull();
    expect(rsc).toBeNull();
  });

  it("skips a special error whose render turned dynamic", async () => {
    const { route } = await prerenderSpecialErrorPage((res) => {
      res.statusCode = 404;
      res.setHeader("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
      res.setHeader(VINEXT_PRERENDER_SPECIAL_ERROR_HEADER, "{}");
      res.end(boundaryDocument);
    });

    expect(route).toMatchObject({ status: "skipped", reason: "dynamic" });
  });
});

// ─── Pages Router ─────────────────────────────────────────────────────────────

describe("prerenderPages — basePath export", () => {
  it("requests and writes Pages exports under basePath", async () => {
    const root = tmpDir("vinext-prerender-pages-basepath-");
    const outDir = path.join(root, "out");
    const pagesDir = path.join(root, "pages");
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(pagesDir, "about.tsx"),
      "export default function About() { return null; }\n",
    );
    fs.writeFileSync(
      path.join(pagesDir, "index.tsx"),
      "export default function Home() { return null; }\n",
    );

    const requestedPaths: string[] = [];
    const server = createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.url !== "/docs" && req.url !== "/docs/about") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const responsePath = req.url === "/docs/about" ? "/docs/about" : "/docs";
      res.setHeader("content-type", "text/html");
      res.end(`<!DOCTYPE html><html><body>Pages basePath ${responsePath}</body></html>`);
    });

    const port = await listen(server);
    try {
      const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
      const { pagesRouter, apiRouter } =
        await import("../packages/vinext/src/routing/pages-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await pagesRouter(pagesDir);
      const apiRoutes = await apiRouter(pagesDir);
      const config = await resolveNextConfig({ basePath: "/docs", output: "export" });

      const result = await prerenderPages({
        mode: "export",
        routes,
        apiRoutes,
        pagesDir,
        outDir,
        config,
        _prodServer: { server, port },
      });

      expect(requestedPaths).toEqual(expect.arrayContaining(["/docs", "/docs/about"]));
      expect(findRoute(result.routes, "/about")).toMatchObject({
        route: "/about",
        status: "rendered",
        outputFiles: ["docs/about.html"],
      });
      expect(fs.readFileSync(path.join(outDir, "docs", "about.html"), "utf8")).toContain(
        "Pages basePath /docs/about",
      );
      expect(fs.readFileSync(path.join(outDir, "docs.html"), "utf8")).toContain(
        "Pages basePath /docs",
      );
      expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(false);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prerenderPages — default mode (pages-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
    outDir = tmpDir("vinext-prerender-pages-");

    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({});

    const prerenderResult = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // ── Static pages ───────────────────────────────────────────────────────────

  it("renders static index page", () => {
    const r = findRoute(results, "/");
    expect(r).toMatchObject({
      route: "/",
      status: "rendered",
      revalidate: false,
    });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("index.html");
    }
  });

  it("renders static about page", () => {
    const r = findRoute(results, "/about");
    expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("about.html");
    }
  });

  it("renders a static page backed by a bundled CommonJS dependency", () => {
    const r = findRoute(results, "/cjs-dependency-globals-static");
    expect(r).toMatchObject({
      route: "/cjs-dependency-globals-static",
      status: "rendered",
      revalidate: false,
    });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("cjs-dependency-globals-static.html");
      const html = fs.readFileSync(path.join(outDir, "cjs-dependency-globals-static.html"), "utf8");
      expect(html).toContain('<p id="identity-types">string:string</p>');
      expect(html).toContain('<p id="identity-consistent">true</p>');
      expect(html).toContain('<p id="shadowed-global-this">local-globalThis</p>');
      expect(html).toContain('<p id="filename-readable">true</p>');
      // instrumentation.ts completes before the lazy user-module graph loads,
      // and bundled CommonJS globals retain that emitted chunk identity.
      expect(html).toMatch(
        /<p id="concatenated-path">.*\/server\/_next\/static\/concatenated\.js<\/p>/,
      );
    }
  });

  it("renders 404 page", () => {
    const r = findRoute(results, "/404");
    expect(results.filter((result) => result.route === "/404")).toHaveLength(1);
    expect(r).toMatchObject({ route: "/404", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("404.html");
    }
  });

  // ── Dynamic routes with getStaticPaths ────────────────────────────────────

  it("renders static dynamic routes from getStaticPaths (fallback: false)", () => {
    const slugs = ["hello-world", "getting-started"];
    for (const slug of slugs) {
      const r = findRoute(results, `/blog/${slug}`);
      expect(r).toMatchObject({
        route: "/blog/:slug",
        path: `/blog/${slug}`,
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain(`blog/${slug}.html`);
      }
    }
  });

  it("renders dynamic routes from getStaticPaths (fallback: 'blocking')", () => {
    const ids = ["1", "2"];
    for (const id of ids) {
      const r = findRoute(results, `/articles/${id}`);
      expect(r).toMatchObject({
        route: "/articles/:id",
        path: `/articles/${id}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  // Next.js accepts both `paths: Array<{ params }>` and `paths: Array<string>`
  // from getStaticPaths. The string-path variant is documented at
  // https://nextjs.org/docs/pages/api-reference/functions/get-static-paths and
  // implemented in .nextjs-ref/packages/next/src/build/static-paths/pages.ts
  // (the `typeof entry === 'string'` branch around line 89).
  it("renders dynamic routes from getStaticPaths with string paths", () => {
    const slugs = ["hello-world", "another-one"];
    for (const slug of slugs) {
      const r = findRoute(results, `/string-paths/${slug}`);
      expect(r).toMatchObject({
        route: "/string-paths/:slug",
        path: `/string-paths/${slug}`,
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain(`string-paths/${slug}.html`);
      }
    }
  });

  // Next.js rejects entries with a missing `params` key — see
  //   .nextjs-ref/packages/next/src/build/static-paths/pages.ts (around line 169)
  //   "A required parameter (X) was not provided as a string received undefined"
  // We must NOT crash the whole prerender phase on this; surface it as a
  // per-route error result, the same shape we use elsewhere.
  it("surfaces missing-params entries as a per-route error (does not crash)", () => {
    const errored = results.find(
      (r) => r.route === "/missing-params/:slug" && r.status === "error",
    );
    expect(errored).toBeDefined();
    if (errored && errored.status === "error") {
      expect(errored.error).toMatch(/missing the `params` key|params is undefined/);
    }
  });

  // ── ISR page ───────────────────────────────────────────────────────────────

  it("renders ISR page with correct revalidate interval", () => {
    const r = findRoute(results, "/isr-test");
    expect(r).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("isr-test.html");
    }
  });

  // ── SSR pages — skipped ────────────────────────────────────────────────────

  it("skips SSR pages (getServerSideProps) in default mode", () => {
    const ssrRoutes = ["/ssr", "/ssr-headers"];
    for (const route of ssrRoutes) {
      const r = findRoute(results, route);
      expect(r).toMatchObject({ route, status: "skipped", reason: "ssr" });
    }
  });

  it("skips getServerSideProps dynamic route in default mode", () => {
    // posts/[id] has getServerSideProps — pattern is /posts/:id
    const ssrRoute = results.find(
      (r) =>
        r.status === "skipped" &&
        "reason" in r &&
        r.reason === "ssr" &&
        r.route.startsWith("/posts"),
    );
    expect(ssrRoute).toBeDefined();
  });

  // ── API routes — always skipped ────────────────────────────────────────────

  it("skips all API routes", () => {
    const apiResults = results.filter(
      (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
    );
    expect(apiResults.length).toBeGreaterThan(0);
    // hello API is a known API route
    const hello = findRoute(results, "/api/hello");
    expect(hello).toMatchObject({ route: "/api/hello", status: "skipped", reason: "api" });
  });

  // ── Written files ──────────────────────────────────────────────────────────

  it("writes HTML files to outDir", () => {
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "isr-test.html"))).toBe(true);
  });

  // ── vinext-prerender.json ─────────────────────────────────────────────────

  it("writes vinext-prerender.json with correct structure", () => {
    const indexPath = path.join(outDir, "vinext-prerender.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(Array.isArray(index.routes)).toBe(true);

    // Check a rendered entry
    const home = index.routes.find((r: any) => r.route === "/");
    expect(home).toMatchObject({ route: "/", status: "rendered", revalidate: false });
    // outputFiles not in index (stripped)
    expect(home.outputFiles).toBeUndefined();

    // Check ISR entry
    const isr = index.routes.find((r: any) => r.route === "/isr-test");
    expect(isr).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });

    // Check a skipped entry
    const ssr = index.routes.find((r: any) => r.route === "/ssr");
    expect(ssr).toMatchObject({ route: "/ssr", status: "skipped", reason: "ssr" });
  });
});

describe("writePrerenderIndex", () => {
  it("writes metadata artifact paths and response metadata without page classification", () => {
    expect(getAppRouteOutputPath("/products/sitemap/1.xml")).toBe("products/sitemap/1.xml.route");

    const dir = tmpDir("vinext-prerender-metadata-index-");
    writePrerenderIndex(
      [
        {
          route: "/robots.txt",
          status: "rendered",
          outputFiles: [getAppRouteOutputPath("/robots.txt")],
          revalidate: false,
          router: "metadata",
          routeSegments: ["robots"],
          headers: { "content-type": "text/plain" },
          responseStatus: 200,
        },
      ],
      dir,
      { buildId: "metadata-build" },
    );

    const index = JSON.parse(fs.readFileSync(path.join(dir, "vinext-prerender.json"), "utf-8"));
    expect(index.routes[0]).toEqual({
      route: "/robots.txt",
      status: "rendered",
      revalidate: false,
      router: "metadata",
      routeSegments: ["robots"],
      headers: { "content-type": "text/plain" },
      responseStatus: 200,
    });
    expect(index.pregeneratedConcretePaths).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries the resolved cacheLife stale into the written index", () => {
    // Regression: seedMemoryCacheFromPrerender reads `route.stale` from
    // vinext-prerender.json — dropping it here silently reverts seeded cache
    // hits to the configured staleTimes fallback.
    const dir = tmpDir("vinext-prerender-index-");
    writePrerenderIndex(
      [
        {
          route: "/cached",
          status: "rendered",
          outputFiles: ["cached.html"],
          revalidate: 60,
          expire: 300,
          stale: 30,
          router: "app",
        },
      ],
      dir,
      { buildId: "b1" },
    );

    const index = JSON.parse(fs.readFileSync(path.join(dir, "vinext-prerender.json"), "utf-8"));
    expect(index.routes[0]).toMatchObject({
      route: "/cached",
      revalidate: 60,
      expire: 300,
      stale: 30,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("prerenderPages — export mode (pages-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
    outDir = tmpDir("vinext-prerender-pages-export-");

    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({ output: "export" });

    const prerenderResult = await prerenderPages({
      mode: "export",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("renders static and ISR routes (ISR treated as static)", () => {
    expect(findRoute(results, "/")).toMatchObject({ status: "rendered", revalidate: false });
    expect(findRoute(results, "/about")).toMatchObject({ status: "rendered", revalidate: false });
    // ISR route in export mode: revalidate ignored → false
    expect(findRoute(results, "/isr-test")).toMatchObject({
      status: "rendered",
      revalidate: false,
    });
  });

  it("errors on SSR pages in export mode", () => {
    const ssr = findRoute(results, "/ssr");
    expect(ssr).toMatchObject({ status: "error" });
    if (ssr?.status === "error") {
      expect(ssr.error).toMatch(/getServerSideProps/);
    }
  });

  it("includes stack trace in error when enablePrerenderSourceMaps is true", () => {
    // enablePrerenderSourceMaps defaults to true in resolveNextConfig (line 230)
    const errorRoute = findRoute(results, "/error-throw");
    expect(errorRoute).toMatchObject({ status: "error" });
    if (errorRoute?.status === "error") {
      // Verify the error includes a stack trace (multiple lines with "at " frames)
      expect(errorRoute.error).toMatch(/\n\s+at /);
    }
  });
});

// ─── App Router ───────────────────────────────────────────────────────────────

describe("prerenderApp — default mode (app-basic)", () => {
  let outDir: string;
  let results: PrerenderRouteResult[];
  let nextPhaseAfterPrerender: string | undefined;

  beforeAll(async () => {
    const rscBundlePath = await buildAppFixture(APP_FIXTURE);
    outDir = tmpDir("vinext-prerender-app-");

    const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
    const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const appDir = path.resolve(APP_FIXTURE, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({});

    const previousNextPhase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-server";
    try {
      const prerenderResult = await prerenderApp({
        mode: "default",
        rscBundlePath,
        routes,
        outDir,
        config,
      });
      results = prerenderResult.routes;
      nextPhaseAfterPrerender = process.env.NEXT_PHASE;
    } finally {
      if (previousNextPhase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = previousNextPhase;
    }
  }, 120_000);

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // ── Static routes with explicit config ────────────────────────────────────

  it("renders force-static page", () => {
    const r = findRoute(results, "/static-test");
    expect(r).toMatchObject({ route: "/static-test", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("static-test.html");
      expect(r.outputFiles).toContain("static-test.rsc");
    }
    const html = fs.readFileSync(path.join(outDir, "static-test.html"), "utf-8");
    expect(html).toContain("searchParamsFromBrowser:false");
  });

  it("emits the nearest Suspense fallback when useSearchParams bails out during prerender", () => {
    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
    const route = "/nextjs-compat/use-search-params-static-bailout";
    expect(findRoute(results, route)).toMatchObject({
      route,
      status: "rendered",
      revalidate: false,
    });

    const html = fs.readFileSync(
      path.join(outDir, "nextjs-compat/use-search-params-static-bailout.html"),
      "utf8",
    );
    expect(html).toContain('<p id="search-params-suspense">search params suspense</p>');
    expect(html).not.toContain('id="search-params-value"');
  });

  it("renders revalidate=Infinity page as static", () => {
    const r = findRoute(results, "/revalidate-infinity-test");
    expect(r).toMatchObject({ status: "rendered", revalidate: false });
  });

  // ── ISR routes ─────────────────────────────────────────────────────────────

  it("renders ISR page with revalidate=1", () => {
    const r = findRoute(results, "/isr-test");
    expect(r).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("isr-test.html");
      expect(r.outputFiles).toContain("isr-test.rsc");
    }
  });

  it("renders ISR page with revalidate=60", () => {
    const r = findRoute(results, "/revalidate-test");
    expect(r).toMatchObject({ route: "/revalidate-test", status: "rendered", revalidate: 60 });
  });

  it("records App Router preload Link headers for cache seeding", () => {
    const r = findRoute(results, "/nextjs-compat/react-max-headers-length");
    expect(r).toMatchObject({
      status: "rendered",
      headers: { link: expect.stringContaining("rel=preload") },
    });

    const indexPath = path.join(outDir, "vinext-prerender.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const manifestRoute = index.routes.find(
      (route: { route: string }) => route.route === "/nextjs-compat/react-max-headers-length",
    );
    expect(manifestRoute).toMatchObject({
      headers: { link: expect.stringContaining("rel=preload") },
    });
  });

  it("uses the rendered cacheLife expire value for App Router ISR prerender entries", () => {
    const r = findRoute(results, "/prerender-cache-life");
    expect(r).toMatchObject({
      route: "/prerender-cache-life",
      status: "rendered",
      revalidate: 1,
      expire: 3,
    });

    const indexPath = path.join(outDir, "vinext-prerender.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const manifestRoute = index.routes.find(
      (route: { route: string }) => route.route === "/prerender-cache-life",
    );
    expect(manifestRoute).toMatchObject({ revalidate: 1, expire: 3 });
  });

  it("embeds the completed cacheLife stale time in prerendered initial HTML", () => {
    // The prerender path consumes request-scoped cache metadata after the RSC
    // stream settles. The later HTML done script must reuse that completed
    // value so hydration seeds the visited-response cache with the same stale
    // claim that warm HTML/RSC cache-hit headers replay.
    const r = findRoute(results, "/use-cache-test");
    expect(r).toMatchObject({
      route: "/use-cache-test",
      status: "rendered",
      revalidate: 1,
      stale: 30,
    });

    const html = fs.readFileSync(path.join(outDir, "use-cache-test.html"), "utf-8");
    expect(html).toContain("searchParamsFromBrowser:true");
    expect(html).toContain('"initialCacheKind":"static"');
    expect(html).toContain('"staleTimeSeconds":30');
  });

  // Ported from Next.js: test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components-allow-otel-spans/cache-components-allow-otel-spans.test.ts
  // A "use cache" page, and its "use cache" generateMetadata/generateViewport,
  // receive `{ params, searchParams }`. Next.js leaves searchParams out of a
  // public page cache's key and serialized arguments, so reading them must not
  // turn the build-time render dynamic. That holds whether the cache functions
  // are defined in the page file, re-exported from another module, or bound.
  it.each(["inline", "file", "reexport", "bound"])(
    'prerenders %s "use cache" pages that receive page props',
    (directive) => {
      const r = findRoute(results, `/use-cache-page-props/${directive}/prerendered`);
      expect(r).toMatchObject({
        route: `/use-cache-page-props/${directive}/:slug`,
        status: "rendered",
      });
      const html = fs.readFileSync(
        path.join(outDir, `use-cache-page-props/${directive}/prerendered.html`),
        "utf-8",
      );
      expect(html).toContain("prerendered");
      expect(html).toContain("<title>use cache page props prerendered</title>");
    },
  );

  it("renders inline server actions during the production build phase", () => {
    const r = findRoute(results, "/prerender-inline-server-action");
    expect(r).toMatchObject({
      route: "/prerender-inline-server-action",
      status: "rendered",
    });

    const html = fs.readFileSync(path.join(outDir, "prerender-inline-server-action.html"), "utf-8");
    expect(html).toContain('<div id="phase">at buildtime</div>');
    expect(nextPhaseAfterPrerender).toBe("phase-production-server");
  });

  it("records collected App Router cache tags for cache seeding", () => {
    const r = findRoute(results, "/unstable-cache-test");
    expect(r).toMatchObject({
      status: "rendered",
      tags: expect.arrayContaining(["unstable-data"]),
    });

    const indexPath = path.join(outDir, "vinext-prerender.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const manifestRoute = index.routes.find(
      (route: { route: string }) => route.route === "/unstable-cache-test",
    );
    expect(manifestRoute.tags).toEqual(expect.arrayContaining(["unstable-data"]));
  });

  it("infers App Router ISR prerender metadata from cacheLife without route revalidate", () => {
    const r = findRoute(results, "/prerender-cache-life-only");
    expect(r).toMatchObject({
      route: "/prerender-cache-life-only",
      status: "rendered",
      revalidate: 1,
      expire: 3,
    });

    const indexPath = path.join(outDir, "vinext-prerender.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const manifestRoute = index.routes.find(
      (route: { route: string }) => route.route === "/prerender-cache-life-only",
    );
    expect(manifestRoute).toMatchObject({ revalidate: 1, expire: 3 });
  });

  // ── Dynamic routes — skipped ───────────────────────────────────────────────

  it("skips force-dynamic page", () => {
    const r = findRoute(results, "/dynamic-test");
    expect(r).toMatchObject({ route: "/dynamic-test", status: "skipped", reason: "dynamic" });
  });

  it("skips revalidate=0 page", () => {
    const r = findRoute(results, "/revalidate-zero-test");
    expect(r).toMatchObject({ status: "skipped", reason: "dynamic" });
  });

  // ── Dynamic routes with generateStaticParams ───────────────────────────────

  it("renders /blog/[slug] expanded paths", () => {
    const slugs = ["hello-world", "getting-started", "advanced-guide"];
    for (const slug of slugs) {
      const r = findRoute(results, `/blog/${slug}`);
      expect(r).toMatchObject({
        route: "/blog/:slug",
        path: `/blog/${slug}`,
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain(`blog/${slug}.html`);
        expect(r.outputFiles).toContain(`blog/${slug}.rsc`);
      }
    }
  });

  it("renders /products/[id] expanded paths", () => {
    for (const id of ["1", "2", "3"]) {
      const r = findRoute(results, `/products/${id}`);
      expect(r).toMatchObject({
        route: "/products/:id",
        path: `/products/${id}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("renders /shop/[category] expanded paths", () => {
    for (const category of ["electronics", "clothing"]) {
      const r = findRoute(results, `/shop/${category}`);
      expect(r).toMatchObject({
        route: "/shop/:category",
        path: `/shop/${category}`,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("renders /shop/[category]/[item] top-down params (nested generateStaticParams)", () => {
    const paths = [
      "/shop/electronics/phone",
      "/shop/electronics/laptop",
      "/shop/clothing/shirt",
      "/shop/clothing/pants",
    ];
    for (const urlPath of paths) {
      const r = findRoute(results, urlPath);
      expect(r).toMatchObject({
        route: "/shop/:category/:item",
        path: urlPath,
        status: "rendered",
        revalidate: false,
      });
    }
  });

  it("dedups duplicate generateStaticParams entries (renders /dedup-params/:slug once each)", () => {
    // generateStaticParams returns [{slug:'alpha'},{slug:'alpha'},{slug:'beta'}].
    // The duplicate 'alpha' must collapse to a single rendered route / manifest
    // entry, matching Next.js' filterUniqueParams. See issue #1983.
    const alpha = results.filter((r) => "path" in r && r.path === "/dedup-params/alpha");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]).toMatchObject({
      route: "/dedup-params/:slug",
      path: "/dedup-params/alpha",
      status: "rendered",
    });

    const beta = results.filter((r) => "path" in r && r.path === "/dedup-params/beta");
    expect(beta).toHaveLength(1);
  });

  it("skips dynamic routes without generateStaticParams", () => {
    // /photos/[id] has no generateStaticParams
    const r = results.find(
      (r) =>
        r.status === "skipped" &&
        "reason" in r &&
        r.reason === "no-static-params" &&
        r.route.startsWith("/photos"),
    );
    expect(r).toBeDefined();
  });

  // ── Speculative rendering: unknown routes ──────────────────────────────────

  it("renders / speculatively (unknown route with no dynamic APIs)", () => {
    const r = findRoute(results, "/");
    expect(r).toMatchObject({ route: "/", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("index.html");
      expect(r.outputFiles).toContain("index.rsc");
    }
  });

  it("renders /about speculatively", () => {
    const r = findRoute(results, "/about");
    expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
  });

  it("renders /dashboard speculatively", () => {
    const r = findRoute(results, "/dashboard");
    expect(r).toMatchObject({ route: "/dashboard", status: "rendered", revalidate: false });
  });

  it("skips a client page that reads searchParams in SSR", () => {
    // Next.js's build makes a client page that reads searchParams dynamic.
    // https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
    expect(findRoute(results, "/client-page-search-params")).toMatchObject({
      route: "/client-page-search-params",
      status: "skipped",
      reason: "dynamic",
    });
    // force-static reads an empty query, which isn't a read.
    expect(findRoute(results, "/client-page-search-params/force-static")).toMatchObject({
      status: "rendered",
      revalidate: false,
    });
  });

  it("renders layout-only routes whose content comes from parallel slots", () => {
    // Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception/parallel-routes-and-interception.test.ts
    const parent = findRoute(results, "/parallel-nested/home");
    expect(parent).toMatchObject({
      route: "/parallel-nested/home",
      status: "rendered",
      revalidate: false,
    });

    const nested = findRoute(results, "/parallel-nested/home/nested");
    expect(nested).toMatchObject({
      route: "/parallel-nested/home/nested",
      status: "rendered",
      revalidate: false,
    });

    const defaultOnly = findRoute(results, "/slot-collision");
    expect(defaultOnly).toMatchObject({
      route: "/slot-collision",
      status: "rendered",
      revalidate: false,
    });
  });

  it("skips /headers-test (unknown route that calls headers())", () => {
    const r = findRoute(results, "/headers-test");
    // headers-test calls headers() — should be skipped as dynamic
    expect(r).toBeDefined();
    expect(r?.status).toBe("skipped");
  });

  // Ported from Next.js: test/e2e/app-dir/rsc-redirect/rsc-redirect.test.ts
  // ('should get 307 status code for document request')
  //
  // A speculative prerender of a route that calls `redirect()` must not
  // follow the redirect server-side and cache the destination's HTML under
  // the redirecting URL. Doing so makes the prod server reply with 200 and
  // the destination's body on every document request to the redirecting
  // route, instead of emitting an HTTP 307 with a Location header.
  //
  // See: https://github.com/cloudflare/vinext/issues/1530
  it("skips /redirect-test instead of capturing the destination HTML", () => {
    const r = findRoute(results, "/redirect-test");
    expect(r).toBeDefined();
    expect(r?.status).toBe("skipped");
    // No HTML/RSC must be written for the redirecting route — otherwise the
    // prod server serves the cached destination body with status 200 for
    // every document request to /redirect-test.
    expect(fs.existsSync(path.join(outDir, "redirect-test.html"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "redirect-test.rsc"))).toBe(false);
  });

  // As in Next.js's build, a page's special error that escapes the shell is
  // written with its status and location, beside the page's RSC payload.
  it.each([
    {
      route: "/nextjs-compat/isr-special-error/not-found",
      responseStatus: 404,
      location: undefined,
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    },
    {
      route: "/nextjs-compat/isr-special-error/redirect",
      responseStatus: 307,
      location: "/nextjs-compat/nav-redirect-result",
      digest: "NEXT_REDIRECT;",
    },
  ])(
    "writes $route's special error with status $responseStatus",
    ({ route, responseStatus, location, digest }) => {
      const r = findRoute(results, route);
      expect(r).toMatchObject({ status: "rendered", revalidate: 60, responseStatus });
      if (r?.status !== "rendered") throw new Error(`expected ${route} to render`);
      expect(r.headers?.location).toBe(location);
      const rsc = fs.readFileSync(path.join(outDir, `${route.slice(1)}.rsc`), "utf8");
      expect(rsc).toContain(digest);
    },
  );

  // A Suspense boundary caught the special error, so the shell rendered.
  it("writes a special error caught under loading.tsx as a 200", () => {
    const r = findRoute(results, "/nextjs-compat/isr-special-error/loading-not-found");
    expect(r).toMatchObject({ status: "rendered", revalidate: 60 });
    expect(r).not.toHaveProperty("responseStatus");
  });

  // ── API routes — always skipped ────────────────────────────────────────────

  it("skips all API route handlers", () => {
    const apiSkipped = results.filter(
      (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
    );
    expect(apiSkipped.length).toBeGreaterThan(0);

    // Known API routes
    const hello = findRoute(results, "/api/hello");
    expect(hello).toMatchObject({ status: "skipped", reason: "api" });
  });

  // ── Written files ──────────────────────────────────────────────────────────

  it("writes HTML and RSC files to outDir", () => {
    expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "index.rsc"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "static-test.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "static-test.rsc"))).toBe(true);
  });

  it("writes blog expanded pages to correct paths", () => {
    expect(fs.existsSync(path.join(outDir, "blog/hello-world.html"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "blog/hello-world.rsc"))).toBe(true);
  });

  // ── vinext-prerender.json ─────────────────────────────────────────────────

  it("writes vinext-prerender.json with correct structure", () => {
    const indexPath = path.join(outDir, "vinext-prerender.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(Array.isArray(index.routes)).toBe(true);

    // Rendered routes present — for dynamic routes the manifest has both route (pattern) and path (concrete URL)
    const rendered = index.routes
      .filter((r: any) => r.status === "rendered")
      .map((r: any) => r.path ?? r.route);
    expect(rendered).toContain("/");
    expect(rendered).toContain("/blog/hello-world");
    expect(rendered).toContain("/blog/getting-started");
    expect(rendered).toContain("/blog/advanced-guide");
    expect(rendered).toContain("/products/1");
    expect(rendered).toContain("/products/2");
    expect(rendered).toContain("/products/3");
    expect(rendered).toContain("/shop/electronics");
    expect(rendered).toContain("/shop/clothing");
    expect(rendered).toContain("/shop/electronics/phone");

    // ISR route has correct revalidate
    const isrTest = index.routes.find((r: any) => r.route === "/isr-test");
    expect(isrTest).toMatchObject({ route: "/isr-test", status: "rendered", revalidate: 1 });

    // outputFiles not in index
    expect(isrTest?.outputFiles).toBeUndefined();

    // Skipped route present
    const dynamic = index.routes.find((r: any) => r.route === "/dynamic-test");
    expect(dynamic).toMatchObject({ route: "/dynamic-test", status: "skipped", reason: "dynamic" });
  });
});

// ─── Hybrid: runPrerender with app/ + pages/ ──────────────────────────────────

describe("runPrerender — hybrid app+pages (app-basic)", () => {
  let manifestDir: string;
  let results: PrerenderRouteResult[];

  beforeAll(async () => {
    const pagesBundlePath = await buildPagesFixture(APP_FIXTURE);
    manifestDir = tmpDir("vinext-prerender-hybrid-");

    // runPrerender writes files to real paths derived from root, but we
    // override by calling prerenderPages/prerenderApp directly with a tmp
    // manifestDir. Instead, call runPrerender which needs a real-looking root.
    // We test it indirectly: call prerenderPages on app-basic's pages/ dir
    // with a manifestDir so we can check hybrid manifest merging.
    const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
    const { pagesRouter, apiRouter } =
      await import("../packages/vinext/src/routing/pages-router.js");
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");

    const pagesDir = path.resolve(APP_FIXTURE, "pages");
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({});

    const prerenderResult = await prerenderPages({
      mode: "default",
      pagesBundlePath,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir: manifestDir,
      config,
    });
    results = prerenderResult.routes;
  }, 60_000);

  afterAll(() => {
    fs.rmSync(manifestDir, { recursive: true, force: true });
  });

  it("renders old-school static page from pages/ in app-basic fixture", () => {
    const r = findRoute(results, "/old-school");
    expect(r).toMatchObject({ route: "/old-school", status: "rendered", revalidate: false });
    if (r?.status === "rendered") {
      expect(r.outputFiles).toContain("old-school.html");
    }
  });

  it("skips pages-header-override-delete (getServerSideProps) in default mode", () => {
    const r = findRoute(results, "/pages-header-override-delete");
    expect(r).toMatchObject({
      route: "/pages-header-override-delete",
      status: "skipped",
      reason: "ssr",
    });
  });
});

describe("prerender — generateStaticParams/getStaticPaths errors (#1982)", () => {
  // Ported from Next.js: test/production/app-dir/generate-static-params-errors/generate-static-params-errors.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/production/app-dir/generate-static-params-errors/generate-static-params-errors.test.ts
  // Next.js surfaces the real generateStaticParams/getStaticPaths error and fails the build. vinext
  // must not swallow the 500 returned by the static-params/static-paths endpoint into a misleading
  // "stale or missing prerender secret" skip — the route must fail with the real error message.
  //
  // NOTE: these tests mock the prerender endpoint's HTTP response (the prod server here has no
  // secret configured), so they exercise the build-side proxy's status branching, not the real
  // app-prerender-endpoints.ts 500 path end-to-end. The endpoint's own behaviour (throw → 500 with
  // `{ error }`) is covered by tests/app-prerender-endpoints.test.ts.
  it("surfaces a thrown generateStaticParams error instead of silently skipping the route", async () => {
    const root = tmpDir("vinext-prerender-gsp-error-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pageDir = path.join(appDir, "blog", "[slug]");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(pageDir, "page.tsx"),
      "export default function Page() { return null; }\n",
    );

    // The static-params endpoint returns 500 with the real error in the body when
    // the user's generateStaticParams throws (app-prerender-endpoints.ts).
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Error: boom from generateStaticParams" }));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(`0:["$","div",null,{}]\n`) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const result = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      const route = result.routes.find((r) => r.route.includes("slug"));
      // `fatal: true` makes run-prerender fail the build in default mode too,
      // matching Next.js (not just a visible-but-non-fatal error). #1982
      expect(route).toMatchObject({ status: "error", fatal: true });
      if (route?.status !== "error") {
        throw new Error("expected the throwing generateStaticParams route to fail prerender");
      }
      expect(route.error).toContain("boom from generateStaticParams");
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still warn-skips (does not fail) when the static-params endpoint 404s (disabled/stale secret)", async () => {
    const root = tmpDir("vinext-prerender-gsp-secret-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pageDir = path.join(appDir, "blog", "[slug]");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(pageDir, "page.tsx"),
      "export default function Page() { return null; }\n",
    );

    // A 404 models the genuine disabled / stale-secret case (notFoundResponse),
    // which must keep the warn-and-skip behavior rather than failing the build.
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(`0:["$","div",null,{}]\n`) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({});

      const result = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config,
        _prodServer: { server, port },
      });

      const route = result.routes.find((r) => r.route.includes("slug"));
      expect(route).toMatchObject({ status: "skipped", reason: "no-static-params" });
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Next.js keeps a route with generateStaticParams() returning [] in its SSG
  // prerender metadata so unknown paths can be generated on demand.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/app-page-runtime.ts
  it("retains route-level SSG metadata when generateStaticParams returns no paths", async () => {
    const root = tmpDir("vinext-prerender-empty-gsp-");
    const outDir = path.join(root, "out");
    const pageDir = path.join(root, "app", "blog", "[slug]");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(pageDir, "page.tsx"),
      "export function generateStaticParams() { return []; }\nexport default function Page() { return null; }\n",
    );

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.setHeader("content-type", "application/json");
        res.end("[]");
        return;
      }
      res.statusCode = 500;
      res.end("an empty static params route should not render at build time");
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(path.join(root, "app"));
      const result = await prerenderApp({
        mode: "default",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes,
        outDir,
        config: await resolveNextConfig({}),
        _prodServer: { server, port },
      });

      expect(result.routes).toContainEqual({
        route: "/blog/:slug",
        status: "skipped",
        reason: "empty-static-params",
      });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(outDir, "vinext-prerender.json"), "utf8"),
      );
      expect(manifest.pregeneratedConcretePaths).toContainEqual(["/blog/:slug", []]);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a thrown getStaticPaths error instead of silently skipping the route", async () => {
    const root = tmpDir("vinext-prerender-pages-gsp-error-");
    const outDir = path.join(root, "out");
    const pagesDir = path.join(root, "pages");
    fs.mkdirSync(path.join(pagesDir, "posts"), { recursive: true });
    fs.writeFileSync(
      path.join(pagesDir, "posts", "[id].tsx"),
      "export default function Post() { return null; }\n",
    );

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/pages-static-paths") {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Error: boom from getStaticPaths" }));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end("<html><body>ok</body></html>");
    });

    const port = await listen(server);
    try {
      const { prerenderPages } = await import("../packages/vinext/src/build/prerender.js");
      const { pagesRouter, apiRouter } =
        await import("../packages/vinext/src/routing/pages-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await pagesRouter(pagesDir);
      const apiRoutes = await apiRouter(pagesDir);
      const config = await resolveNextConfig({});

      const result = await prerenderPages({
        mode: "default",
        routes,
        apiRoutes,
        pagesDir,
        outDir,
        config,
        _prodServer: { server, port },
      });

      const route = result.routes.find((r) => r.route.includes("posts"));
      // `fatal: true` makes run-prerender fail the build in default mode too. #1982
      expect(route).toMatchObject({ status: "error", fatal: true });
      if (route?.status !== "error") {
        throw new Error("expected the throwing getStaticPaths route to fail prerender");
      }
      expect(route.error).toContain("boom from getStaticPaths");
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prerenderApp — layout generateStaticParams", () => {
  // Next.js walks every segment of a route's loader tree top-down, passing each
  // parent param set to the next generateStaticParams, layouts included
  // (build/static-paths/app.ts generateRouteStaticParams).
  it("composes the last dynamic segment's layout with the layouts above it under output: 'export'", async () => {
    const root = tmpDir("vinext-prerender-layout-gsp-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const writeAppFile = (relativePath: string, content: string) => {
      const filePath = path.join(appDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    };
    const layout = (params: string) =>
      [
        `export function generateStaticParams() { return [${params}]; }`,
        "export default function Layout({ children }) { return children; }",
      ].join("\n");
    const page = "export default function Page() { return null; }\n";
    writeAppFile("[lang]/layout.tsx", layout("{ lang: 'en' }"));
    writeAppFile("[lang]/[category]/layout.tsx", layout("{ category: 'news' }"));
    writeAppFile("[lang]/[category]/details/page.tsx", page);
    writeAppFile("single/[topic]/layout.tsx", layout("{ topic: 'sport' }"));
    writeAppFile("single/[topic]/details/page.tsx", page);

    const staticParamsByKey: Record<string, unknown> = {
      "layouts:[lang]": [{ lang: "en" }],
      "layouts:[lang]/[category]": [{ category: "news" }],
      "layouts:single/[topic]": [{ topic: "sport" }],
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(staticParamsByKey[url.searchParams.get("pattern") ?? ""] ?? null));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(`0:["$","div",null,{}]\n`) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const result = await prerenderApp({
        mode: "export",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes: await appRouter(appDir),
        outDir,
        config: await resolveNextConfig({ output: "export" }),
        _prodServer: { server, port },
      });

      expect(findRoute(result.routes, "/en/news/details")).toMatchObject({
        route: "/:lang/:category/details",
        status: "rendered",
      });
      expect(findRoute(result.routes, "/single/sport/details")).toMatchObject({
        route: "/single/:topic/details",
        status: "rendered",
      });
      expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Next.js validates the composed layout params against the route's pathname
  // params (build/static-paths/app.ts validateParams), so a non-string value
  // for a single dynamic segment is rejected rather than rendered.
  it("rejects a layout-only param set whose values do not fit the route pattern", async () => {
    const root = tmpDir("vinext-prerender-layout-gsp-invalid-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    fs.mkdirSync(path.join(appDir, "[id]", "details"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "[id]", "layout.tsx"),
      [
        "export function generateStaticParams() { return [{ id: ['a', 'b'] }]; }",
        "export default function Layout({ children }) { return children; }",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(appDir, "[id]", "details", "page.tsx"),
      "export default function Page() { return null; }\n",
    );

    const renderedPaths: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.setHeader("content-type", "application/json");
        const pattern = url.searchParams.get("pattern");
        res.end(JSON.stringify(pattern === "layouts:[id]" ? [{ id: ["a", "b"] }] : null));
        return;
      }
      renderedPaths.push(url.pathname);
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(`0:["$","div",null,{}]\n`) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const result = await prerenderApp({
        mode: "export",
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes: await appRouter(appDir),
        outDir,
        config: await resolveNextConfig({ output: "export" }),
        _prodServer: { server, port },
      });

      expect(result.routes.find((route) => route.route === "/:id/details")).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          "Parameter id from generateStaticParams for /:id/details must be a string.",
        ),
      });
      expect(renderedPaths.filter((pathname) => pathname.endsWith("/details"))).toEqual([]);
      expect(fs.existsSync(path.join(outDir, "a%2Cb"))).toBe(false);
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prerenderApp — layout generateStaticParams contract", () => {
  async function prerenderLayoutApp(
    files: Record<string, string>,
    staticParamsByKey: Record<string, unknown>,
    mode: "default" | "export" = "default",
  ) {
    const root = tmpDir("vinext-prerender-layout-contract-");
    const appDir = path.join(root, "app");
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(appDir, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    const renderedPaths: string[] = [];
    const staticParamRequests: { pattern: string | null; parentParams: string | null }[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        staticParamRequests.push({
          pattern: url.searchParams.get("pattern"),
          parentParams: url.searchParams.get("parentParams"),
        });
        const staticParams = staticParamsByKey[url.searchParams.get("pattern") ?? ""];
        res.setHeader("content-type", "application/json");
        // A resolver runs through the real endpoint, as in a built server.
        if (typeof staticParams === "function") {
          void handleAppPrerenderEndpoint(new Request(url), {
            isPrerenderEnabled: () => true,
            pathname: url.pathname,
            staticParamsMap: { [url.searchParams.get("pattern") ?? ""]: staticParams as never },
          }).then(async (response) => {
            res.statusCode = response?.status ?? 404;
            res.end(await response?.text());
          });
          return;
        }
        res.end(JSON.stringify(staticParams ?? null));
        return;
      }
      // The raw request target, so an empty segment ("//details") shows.
      renderedPaths.push((req.url ?? "").split("?")[0]);
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(`0:["$","div",null,{}]\n`) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });
    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const result = await prerenderApp({
        mode,
        rscBundlePath: path.join(root, "dist", "server", "index.js"),
        routes: await appRouter(appDir),
        outDir: path.join(root, "out"),
        config: await resolveNextConfig({}),
        _prodServer: { server, port },
      });
      return { result, renderedPaths, staticParamRequests };
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const layout = "export default function Layout({ children }) { return children; }\n";
  const page = "export default function Page() { return null; }\n";

  // Outside a partial prerender, Next.js skips a set whose required pathname
  // value is empty rather than building a path with an empty segment
  // (build/static-paths/app.ts buildAppStaticPaths).
  it("skips a layout-only set with an empty required value", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[id]/layout.tsx": layout, "[id]/details/page.tsx": page },
      { "layouts:[id]": [{ id: "" }, { id: "a" }] },
    );

    expect(renderedPaths.filter((pathname) => pathname.endsWith("/details"))).toEqual([
      "/a/details",
    ]);
    expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
  });

  // Next.js's validateParams throws, failing `next build` in every mode.
  it("fails a default build when a layout-only set breaks the route's param contract", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[id]/layout.tsx": layout, "[id]/details/page.tsx": page },
      { "layouts:[id]": [{ id: ["a"] }] },
    );

    expect(result.routes.find((route) => route.route === "/:id/details")).toMatchObject({
      status: "error",
      fatal: true,
      error: expect.stringContaining(
        "Parameter id from generateStaticParams for /:id/details must be a string.",
      ),
    });
    expect(renderedPaths.filter((pathname) => pathname.endsWith("/details"))).toEqual([]);
  });

  // Next.js validates the final params composed from the layouts and the page
  // (build/static-paths/app.ts validateParams), not only layout-only sets.
  it("rejects a layout-plus-page set that breaks the route's param contract", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[id]/mid/layout.tsx": layout, "[id]/mid/[slug]/page.tsx": page },
      {
        "layouts:[id]/mid": [{ id: ["a", "b"] }],
        "/:id/mid/:slug": [{ slug: "ok" }],
      },
    );

    expect(result.routes.find((route) => route.route === "/:id/mid/:slug")).toMatchObject({
      status: "error",
      fatal: true,
      error: expect.stringContaining(
        "Parameter id from generateStaticParams for /:id/mid/:slug must be a string.",
      ),
    });
    expect(renderedPaths.filter((pathname) => pathname.includes("/mid/"))).toEqual([]);
  });

  // Next.js fails an export build whose generated params leave out a pathname
  // param (build/static-paths/app.ts buildAppStaticPaths), instead of
  // prerendering none of them as a normal build does.
  it("fails a static export whose composed sets are incomplete", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[lang]/layout.tsx": layout, "[lang]/[slug]/page.tsx": page },
      { "layouts:[lang]": [{ lang: "en" }], "/:lang/:slug": [{ slug: "x" }, {}] },
      "export",
    );

    expect(result.routes.find((route) => route.route === "/:lang/:slug")).toMatchObject({
      status: "error",
      error: expect.stringContaining(
        'Page "/:lang/:slug" returned incomplete params from "generateStaticParams()". With "output: export", every params object must include all dynamic route parameters. Missing: "slug".',
      ),
    });
    expect(renderedPaths.filter((pathname) => pathname.startsWith("/en"))).toEqual([]);
  });

  // Next.js calls each loader-tree segment's generateStaticParams as its own
  // step, and calls the next one once with `{}` while no parent sets exist
  // (build/static-paths/app.ts generateRouteStaticParams), so a route group's
  // layout at the same prefix still runs after the layout above returns [].
  it("calls a same-prefix route group layout once with no params after an empty layout", async () => {
    const { result, renderedPaths, staticParamRequests } = await prerenderLayoutApp(
      {
        "[lang]/layout.tsx": layout,
        "[lang]/(group)/layout.tsx": layout,
        "[lang]/(group)/[slug]/page.tsx": page,
      },
      {
        "layouts:[lang]": [],
        "layouts:[lang]/(group)": [{ lang: "en" }],
        "/:lang/:slug": [{ slug: "x" }],
      },
    );

    expect(staticParamRequests).toEqual([
      { pattern: "layouts:[lang]", parentParams: null },
      { pattern: "layouts:[lang]/(group)", parentParams: null },
      { pattern: "/:lang/:slug", parentParams: JSON.stringify({ lang: "en" }) },
    ]);
    expect(renderedPaths).toContain("/en/x");
    expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
  });

  // Outside a partial prerender and export, Next.js passes each parent set
  // through a generateStaticParams that returns no params, the route's own
  // included (build/static-paths/app.ts generateRouteStaticParams).
  it("keeps a layout's params when the route's own generateStaticParams returns none", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[lang]/layout.tsx": layout, "[lang]/details/page.tsx": page },
      { "layouts:[lang]": [{ lang: "en" }], "/:lang/details": [] },
    );

    expect(renderedPaths).toContain("/en/details");
    expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
  });

  it("passes parents through an empty layout at the route's own pattern", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      {
        "[lang]/layout.tsx": layout,
        "[lang]/[slug]/layout.tsx": layout,
        "[lang]/[slug]/page.tsx": page,
      },
      {
        "layouts:[lang]": [{ lang: "en" }],
        "/:lang/:slug": createAppPrerenderStaticParamsResolver([() => [], () => [{ slug: "x" }]]),
      },
    );

    expect(renderedPaths).toContain("/en/x");
    expect(result.routes.filter((route) => route.status === "error")).toEqual([]);
  });

  // Next.js skips a set whose required scalar param is empty
  // (build/static-paths/app.ts), so a page reached after an empty layout at
  // the same pattern can't queue `/` for `/:id`.
  it("skips an empty required param reached after an empty layout at the route's own pattern", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[id]/layout.tsx": layout, "[id]/page.tsx": page },
      { "/:id": createAppPrerenderStaticParamsResolver([() => [], () => [{ id: "" }]]) },
    );

    expect(renderedPaths).not.toContain("/");
    expect(result.routes.find((route) => route.route === "/:id")).toMatchObject({
      status: "skipped",
    });
  });

  // A passed-through set that leaves a pathname param out is incomplete, so
  // Next.js prerenders none of the route's paths (hadAllParamsGenerated) and
  // leaves them to on-demand generation.
  it("still skips an incomplete set passed through an empty own result", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      { "[lang]/layout.tsx": layout, "[lang]/[slug]/page.tsx": page },
      { "layouts:[lang]": [{ lang: "en" }], "/:lang/:slug": [] },
    );

    expect(result.routes.find((route) => route.route === "/:lang/:slug")).toMatchObject({
      status: "skipped",
      reason: "empty-static-params",
    });
    expect(renderedPaths.filter((pathname) => pathname.startsWith("/en"))).toEqual([]);
  });

  // Next.js rejects malformed generateStaticParams output in every mode
  // (build/static-paths/app.ts callGenerateStaticParams), so a later layout
  // must not run as if the malformed one had returned [].
  it("fails the build when a layout's malformed output precedes a valid route group layout", async () => {
    const { result, renderedPaths } = await prerenderLayoutApp(
      {
        "[lang]/layout.tsx": layout,
        "[lang]/(group)/layout.tsx": layout,
        "[lang]/(group)/[slug]/page.tsx": page,
      },
      {
        "layouts:[lang]": createAppPrerenderStaticParamsResolver([() => undefined]),
        "layouts:[lang]/(group)": createAppPrerenderStaticParamsResolver([() => [{ lang: "en" }]]),
        "/:lang/:slug": createAppPrerenderStaticParamsResolver([() => [{ slug: "x" }]]),
      },
    );

    expect(result.routes.find((route) => route.route === "/:lang/:slug")).toMatchObject({
      status: "error",
      fatal: true,
      error: expect.stringContaining("generateStaticParams must return an array"),
    });
    expect(renderedPaths.filter((pathname) => pathname.startsWith("/en"))).toEqual([]);
  });

  // Next.js fails an export build on any generateStaticParams call that
  // returns no params (build/static-paths/app.ts callGenerateStaticParams),
  // including the route's own segments, whether or not layouts above it
  // supplied parent sets.
  it.each([
    [
      "after its layouts supply parent sets",
      { "[lang]/layout.tsx": layout, "[lang]/[slug]/page.tsx": page },
      { "layouts:[lang]": [{ lang: "en" }], "/:lang/:slug": [] },
      "/:lang/:slug",
    ],
    ["with no parent sets", { "[slug]/page.tsx": page }, { "/:slug": [] }, "/:slug"],
    [
      "from a layout at its own pattern",
      {
        "[lang]/layout.tsx": layout,
        "[lang]/[slug]/layout.tsx": layout,
        "[lang]/[slug]/page.tsx": page,
      },
      {
        "layouts:[lang]": [{ lang: "en" }],
        "/:lang/:slug": createAppPrerenderStaticParamsResolver([() => [], () => [{ slug: "x" }]]),
      },
      "/:lang/:slug",
    ],
  ])(
    "fails a static export when the route's own generateStaticParams returns no params %s",
    async (_label, files, staticParamsByKey, pattern) => {
      const { result, renderedPaths } = await prerenderLayoutApp(
        files,
        staticParamsByKey,
        "export",
      );

      expect(result.routes.find((route) => route.route === pattern)).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          `Page "${pattern}" returned an empty array from "generateStaticParams()". With "output: export", at least one route must be generated.`,
        ),
      });
      expect(result.routes.some((route) => route.status === "skipped")).toBe(false);
      expect(renderedPaths.filter((pathname) => !pathname.startsWith("/__vinext"))).toEqual([]);
    },
  );
});

describe("routeStaticParamSets", () => {
  // Ported from Next.js build/static-paths/app.ts buildAppStaticPaths.
  it("skips sets with an empty required value but keeps an empty optional catch-all", () => {
    expect(
      routeStaticParamSets({ pattern: "/:id/docs/:path*" }, [
        { id: "", path: ["a"] },
        { id: "b", path: null },
        { id: "c", path: [] },
      ]),
    ).toEqual([
      { id: "b", path: [] },
      { id: "c", path: [] },
    ]);
  });

  it("prerenders none of the sets unless every set names every pathname param", () => {
    expect(routeStaticParamSets({ pattern: "/:a/:b" }, [{ a: "x", b: "y" }, { a: "z" }])).toEqual(
      [],
    );
    expect(() =>
      routeStaticParamSets({ pattern: "/:a/:b" }, [{ a: "x", b: "y" }, { a: "z" }], {
        staticExport: true,
      }),
    ).toThrow('Missing: "b".');
  });

  it("rejects a set whose value does not fit its segment", () => {
    expect(() => routeStaticParamSets({ pattern: "/:id" }, [{ id: 1 }])).toThrow(
      "Parameter id from generateStaticParams for /:id must be a string.",
    );
  });
});

describe("prerenderApp — cacheComponents PPR fallback-shell artifacts", () => {
  async function prerenderDynamicRootParamRoute(
    cacheComponents: boolean,
    experimentalFallbackShells = false,
  ) {
    const root = tmpDir("vinext-prerender-ppr-shell-");
    const outDir = path.join(root, "out");
    const appDir = path.join(root, "app");
    const pageDir = path.join(appDir, "[locale]", "blog", "[slug]");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "[locale]", "layout.tsx"),
      "export default function Layout({ children }: { children: React.ReactNode }) { return children; }\n",
    );
    fs.writeFileSync(
      path.join(pageDir, "page.tsx"),
      "export default function Page() { return null; }\n",
    );

    const renderedPaths: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__vinext/prerender/static-params") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ locale: "en", slug: "hello" }]));
        return;
      }
      if (url.pathname === "/__vinext_nonexistent_for_404__") {
        res.statusCode = 404;
        res.end("<html><body>not found</body></html>");
        return;
      }

      renderedPaths.push(url.pathname);
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body>" +
          runtimeRscChunkScript(
            `0:["$","div",null,{"children":${JSON.stringify(url.pathname)}}]\n`,
          ) +
          runtimeRscDoneScript() +
          "</body></html>",
      );
    });

    const port = await listen(server);
    try {
      const { prerenderApp } = await import("../packages/vinext/src/build/prerender.js");
      const { appRouter } = await import("../packages/vinext/src/routing/app-router.js");
      const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
      const routes = await appRouter(appDir);
      const config = await resolveNextConfig({ cacheComponents });

      const previousExperimentalFallbackShells =
        process.env.__VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS;
      if (experimentalFallbackShells) {
        process.env.__VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS = "1";
      } else {
        delete process.env.__VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS;
      }

      let result;
      try {
        result = await prerenderApp({
          mode: "default",
          rscBundlePath: path.join(root, "dist", "server", "index.js"),
          routes,
          outDir,
          config,
          _prodServer: { server, port },
        });
      } finally {
        if (previousExperimentalFallbackShells === undefined) {
          delete process.env.__VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS;
        } else {
          process.env.__VINEXT_EXPERIMENTAL_PPR_FALLBACK_SHELLS =
            previousExperimentalFallbackShells;
        }
      }

      const fallbackHtmlPath = path.join(outDir, "en", "blog", "[slug].html");
      const fallbackHtml = fs.existsSync(fallbackHtmlPath)
        ? fs.readFileSync(fallbackHtmlPath, "utf8")
        : null;

      return { fallbackHtml, renderedPaths, routes: result.routes };
    } finally {
      await closeServer(server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("does not queue incomplete fallback-shell artifacts by default", async () => {
    const { renderedPaths, routes } = await prerenderDynamicRootParamRoute(true);

    expect(findRoute(routes, "/en/blog/hello")).toMatchObject({
      route: "/:locale/blog/:slug",
      path: "/en/blog/hello",
      status: "rendered",
    });
    expect(findRoute(routes, "/en/blog/[slug]")).toBeUndefined();
    expect(renderedPaths).toContain("/en/blog/hello");
    expect(renderedPaths).not.toContain("/en/blog/[slug]");
  });

  it("queues fallback-shell artifacts only with the internal opt-in", async () => {
    const { fallbackHtml, renderedPaths, routes } = await prerenderDynamicRootParamRoute(
      true,
      true,
    );

    expect(findRoute(routes, "/en/blog/hello")).toMatchObject({
      route: "/:locale/blog/:slug",
      path: "/en/blog/hello",
      status: "rendered",
    });
    expect(findRoute(routes, "/en/blog/[slug]")).toMatchObject({
      route: "/:locale/blog/:slug",
      path: "/en/blog/[slug]",
      status: "rendered",
      fallback: true,
    });
    expect(renderedPaths).toEqual(expect.arrayContaining(["/en/blog/hello", "/en/blog/[slug]"]));
    expect(fallbackHtml).toContain("<!--vinext-ppr-dynamic-fallback-shell-->");
  });

  it("does not queue fallback-shell artifacts when cacheComponents is disabled", async () => {
    const { renderedPaths, routes } = await prerenderDynamicRootParamRoute(false);

    expect(findRoute(routes, "/en/blog/hello")).toMatchObject({
      route: "/:locale/blog/:slug",
      path: "/en/blog/hello",
      status: "rendered",
    });
    expect(findRoute(routes, "/en/blog/[slug]")).toBeUndefined();
    expect(renderedPaths).toContain("/en/blog/hello");
    expect(renderedPaths).not.toContain("/en/blog/[slug]");
  });
});

// ─── runPrerender — output: 'export' wiring ───────────────────────────────────

describe("runPrerender — output: 'export' wiring", () => {
  let fixtureDir: string;
  let pagesBundlePath: string;
  let exportNextConfig: Awaited<
    ReturnType<typeof import("../packages/vinext/src/config/next-config.js").resolveNextConfig>
  >;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(
      PAGES_FIXTURE,
      "vinext-run-prerender-",
      undefined,
      path.join(PAGES_FIXTURE, "node_modules"),
    );
    // Pass the bundle path and resolved config to runPrerender so it
    // exercises output: 'export' without touching the real next.config.mjs.
    pagesBundlePath = await buildPagesFixture(PAGES_FIXTURE);
    const { resolveNextConfig } = await import("../packages/vinext/src/config/next-config.js");
    exportNextConfig = await resolveNextConfig({ output: "export" }, fixtureDir);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("throws when next.config output: 'export' and SSR routes exist", async () => {
    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    await expect(
      runPrerender({
        root: fixtureDir,
        nextConfig: exportNextConfig,
        pagesBundlePath,
      }),
    ).rejects.toThrow(/Static export failed/);
  });

  it("does not reload disk config when the caller supplies resolved config", async () => {
    const configPath = path.join(fixtureDir, "next.config.mjs");
    const originalConfig = fs.readFileSync(configPath, "utf-8");

    try {
      fs.writeFileSync(configPath, 'throw new Error("disk config loaded unexpectedly");\n');
      const [{ runPrerender }, { resolveNextConfig }] = await Promise.all([
        import("../packages/vinext/src/build/run-prerender.js"),
        import("../packages/vinext/src/config/next-config.js"),
      ]);
      const nextConfig = await resolveNextConfig({ output: "export" }, fixtureDir);

      await expect(
        runPrerender({
          root: fixtureDir,
          nextConfig,
          pagesBundlePath,
        }),
      ).rejects.toThrow(/Static export failed/);
    } finally {
      fs.writeFileSync(configPath, originalConfig);
    }
  });

  it("does not rewrite the Worker entry when prerender validation fails", async () => {
    const workerEntry = path.join(fixtureDir, "dist", "server", "index.js");
    const source = 'export default { fetch() { return new Response("unchanged"); } };\n';
    fs.mkdirSync(path.dirname(workerEntry), { recursive: true });
    fs.writeFileSync(workerEntry, source, "utf-8");

    try {
      const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
      await expect(
        runPrerender({
          root: fixtureDir,
          nextConfig: exportNextConfig,
          pagesBundlePath,
        }),
      ).rejects.toThrow(/Static export failed/);

      expect(fs.readFileSync(workerEntry, "utf-8")).toBe(source);
    } finally {
      fs.rmSync(path.join(fixtureDir, "dist"), { recursive: true, force: true });
    }
  });

  it("error message names the offending SSR route", async () => {
    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
    await expect(
      runPrerender({
        root: fixtureDir,
        nextConfig: exportNextConfig,
        pagesBundlePath,
      }),
    ).rejects.toThrow(/\/ssr/);
  });
});

// ─── run-prerender fatal-route gate (#1982) ───────────────────────────────────

describe("assertNoFatalPrerenderRoutes (#1982)", () => {
  it("throws (fails the build in default mode) when a route is flagged fatal", async () => {
    const { assertNoFatalPrerenderRoutes } =
      await import("../packages/vinext/src/build/run-prerender.js");
    expect(() =>
      assertNoFatalPrerenderRoutes([
        {
          route: "/blog/:slug",
          status: "error",
          error: "Failed to call generateStaticParams(): boom",
          fatal: true,
        },
      ]),
    ).toThrow(/Prerender failed/);
  });

  it("does not throw for non-fatal errors or skips (default-mode leniency preserved)", async () => {
    const { assertNoFatalPrerenderRoutes } =
      await import("../packages/vinext/src/build/run-prerender.js");
    // A skipped SSR route and a non-fatal error (e.g. a transport failure) must
    // NOT fail the default build — only fatal user-function throws do.
    expect(() =>
      assertNoFatalPrerenderRoutes([
        { route: "/ssr", status: "skipped", reason: "ssr" },
        { route: "/render-fail", status: "error", error: "ECONNREFUSED" },
      ]),
    ).not.toThrow();
  });
});

// ─── App Router — Cloudflare Workers build ────────────────────────────────────
//
// Verifies that prerenderApp() works correctly when the production bundle is a
// Cloudflare Workers build (dist/server/index.js). Prerendering goes through a
// locally-spawned prod server over HTTP — same path as plain Node builds.

// ─── Cloudflare Workers hybrid build (app/ + pages/) ─────────────────────────
//
// Verifies that both prerenderApp() and prerenderPages() work correctly when
// the build is a Cloudflare Workers bundle. Both phases render via HTTP through
// a shared local prod server started by runPrerender().

describe("Cloudflare Workers hybrid build (cf-app-basic)", () => {
  let outDir: string;
  let allResults: PrerenderRouteResult[];

  beforeAll(async () => {
    const { root, rscBundlePath } = await buildCloudflareAppFixture(CF_FIXTURE);
    outDir = path.join(root, "dist", "server", "prerendered-routes");

    const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");

    const result = await runPrerender({ root, rscBundlePath });
    allResults = result?.routes ?? [];
  }, 180_000);

  // ── App Router ──────────────────────────────────────────────────────────────

  describe("prerenderApp — app router via prod server HTTP", () => {
    it("renders / speculatively", () => {
      const r = findRoute(allResults, "/");
      expect(r).toMatchObject({ route: "/", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("index.html");
        expect(r.outputFiles).toContain("index.rsc");
      }
    });

    it("renders /about speculatively", () => {
      const r = findRoute(allResults, "/about");
      expect(r).toMatchObject({ route: "/about", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("about.html");
      }
    });

    it("renders /blog/[slug] expanded from generateStaticParams", () => {
      for (const slug of ["hello-world", "getting-started"]) {
        const r = findRoute(allResults, `/blog/${slug}`);
        expect(r).toMatchObject({
          route: "/blog/:slug",
          path: `/blog/${slug}`,
          status: "rendered",
          revalidate: false,
        });
        if (r?.status === "rendered") {
          expect(r.outputFiles).toContain(`blog/${slug}.html`);
          expect(r.outputFiles).toContain(`blog/${slug}.rsc`);
        }
      }
    });

    it("skips API routes", () => {
      const apiSkipped = allResults.filter(
        (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
      );
      expect(apiSkipped.length).toBeGreaterThan(0);
    });

    it("writes HTML and RSC files to outDir", () => {
      expect(fs.existsSync(path.join(outDir, "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "index.rsc"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "about.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "blog/hello-world.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "blog/hello-world.rsc"))).toBe(true);
    });
  });

  // ── Pages Router ────────────────────────────────────────────────────────────

  describe("prerenderPages — pages router via prod server HTTP", () => {
    it("renders static Pages home", () => {
      const r = findRoute(allResults, "/pages-home");
      expect(r).toMatchObject({ route: "/pages-home", status: "rendered", revalidate: false });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("pages-home.html");
      }
    });

    it("renders static Pages about", () => {
      const r = findRoute(allResults, "/pages-about");
      expect(r).toMatchObject({
        route: "/pages-about",
        status: "rendered",
        revalidate: false,
      });
      if (r?.status === "rendered") {
        expect(r.outputFiles).toContain("pages-about.html");
      }
    });

    it("renders /posts/[id] expanded from getStaticPaths", () => {
      for (const id of ["first", "second"]) {
        const r = findRoute(allResults, `/posts/${id}`);
        expect(r).toMatchObject({
          route: "/posts/:id",
          path: `/posts/${id}`,
          status: "rendered",
          revalidate: false,
        });
        if (r?.status === "rendered") {
          expect(r.outputFiles).toContain(`posts/${id}.html`);
        }
      }
    });

    it("skips API routes", () => {
      const apiSkipped = allResults.filter(
        (r) => r.status === "skipped" && "reason" in r && r.reason === "api",
      );
      expect(apiSkipped.length).toBeGreaterThan(0);
    });

    it("writes HTML files to outDir", () => {
      expect(fs.existsSync(path.join(outDir, "posts/first.html"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "posts/second.html"))).toBe(true);
    });
  });
});

// ─── resolveParentParams unit tests ─────────────────────────────────────────

function mockRoute(
  pattern: string,
  opts: { layoutPrefixes?: string[]; pagePath?: string | null } = {},
): AppRoute {
  const parts = pattern.split("/").filter(Boolean);
  const layoutPrefixes = opts.layoutPrefixes ?? [];
  return {
    pattern,
    pagePath: opts.pagePath ?? `/app${pattern}/page.tsx`,
    routePath: null,
    layouts: layoutPrefixes.map((prefix) => `/app${prefix}/layout.tsx`),
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [],
    notFoundPath: null,
    notFoundPaths: [],
    forbiddenPaths: [],
    forbiddenPath: null,
    unauthorizedPaths: [],
    unauthorizedPath: null,
    routeSegments: parts.map((part) =>
      part.startsWith(":")
        ? part.endsWith("+")
          ? `[...${part.slice(1, -1)}]`
          : part.endsWith("*")
            ? `[[...${part.slice(1, -1)}]]`
            : `[${part.slice(1)}]`
        : part,
    ),
    layoutTreePositions: layoutPrefixes.map((prefix) => prefix.split("/").filter(Boolean).length),
    isDynamic: parts.some((p) => p.startsWith(":")),
    params: parts
      .filter((p) => p.startsWith(":"))
      .map((p) => p.replace(/^:/, "").replace(/[+*]$/, "")),
    patternParts: parts,
    siblingIntercepts: [],
  };
}

describe("resolveParentParams", () => {
  it("returns empty array when route has no parent dynamic segments", async () => {
    const route = mockRoute("/blog/:slug");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("returns empty array when no parent generateStaticParams is registered", async () => {
    const child = mockRoute("/shop/:category/:item");
    const result = await resolveParentParams(child, {});
    expect(result).toEqual([]);
  });

  it("resolves layout-level parent generateStaticParams without requiring a parent page", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    const child = mockRoute("/:lang/:locale/other/:slug", { layoutPrefixes: ["/:lang/:locale"] });
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]/[locale]": async () => [
        { lang: "en", locale: "us" },
        { lang: "es", locale: "es" },
      ],
    };

    const result = await resolveParentParams(child, staticParamsMap);

    expect(result).toEqual([
      { lang: "en", locale: "us" },
      { lang: "es", locale: "es" },
    ]);
  });

  it("resolves parent params from layouts, never from a sibling page at the same prefix", async () => {
    // Next.js composes a route's params from the generateStaticParams of the
    // segments in its own loader tree only (build/static-paths/app.ts).
    const child = mockRoute("/shop/:category/:item", { layoutPrefixes: ["/shop/:category"] });
    const staticParamsMap: StaticParamsMap = {
      "/shop/:category": async () => [{ category: "sibling" }],
      "layouts:shop/[category]": async () => [{ category: "layout" }],
    };

    await expect(resolveParentParams(child, staticParamsMap)).resolves.toEqual([
      { category: "layout" },
    ]);
    await expect(
      resolveParentParams(mockRoute("/:category/details", { layoutPrefixes: ["/:category"] }), {
        "/:category": async () => [],
        "layouts:[category]": async () => [{ category: "layout" }],
      }),
    ).resolves.toEqual([{ category: "layout" }]);
  });

  it("returns empty array when parent has no generateStaticParams", async () => {
    const child = mockRoute("/shop/:category/:item");
    const staticParamsMap: StaticParamsMap = {};
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([]);
  });

  it("skips missing parent providers but bails on malformed non-array results", async () => {
    const child = mockRoute("/shop/:category/:item/:slug", {
      layoutPrefixes: ["/shop/:category", "/shop/:category/:item"],
    });
    const calls: Record<string, string | string[]>[] = [];
    const itemGenerateStaticParams = async ({
      params,
    }: {
      params: Record<string, string | string[]>;
    }) => {
      calls.push(params);
      return [{ item: "shoes" }];
    };
    const staticParamsMap: StaticParamsMap = {
      "layouts:shop/[category]": async () => null,
      "layouts:shop/[category]/[item]": itemGenerateStaticParams,
    };

    const missingProviderResult = await resolveParentParams(child, staticParamsMap);

    expect(missingProviderResult).toEqual([{ item: "shoes" }]);
    expect(calls).toEqual([{}]);

    calls.length = 0;
    const malformedProviderResult = await resolveParentParams(child, {
      "layouts:shop/[category]": async () => undefined,
      "layouts:shop/[category]/[item]": itemGenerateStaticParams,
    });

    expect(malformedProviderResult).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("resolves single parent dynamic segment", async () => {
    const child = mockRoute("/shop/:category/:item", { layoutPrefixes: ["/shop/:category"] });
    const staticParamsMap: StaticParamsMap = {
      "layouts:shop/[category]": async () => [
        { category: "electronics" },
        { category: "clothing" },
      ],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "electronics" }, { category: "clothing" }]);
  });

  it("includes the last dynamic segment's layout when static segments follow it", async () => {
    const child = mockRoute("/:category/foo", { layoutPrefixes: ["/:category"] });
    const staticParamsMap: StaticParamsMap = {
      "layouts:[category]": async () => [{ category: "news" }],
    };

    await expect(resolveParentParams(child, staticParamsMap)).resolves.toEqual([
      { category: "news" },
    ]);
  });

  it("composes every layout above the route's own pattern top-down", async () => {
    // Next.js walks every segment of the route's loader tree top-down, passing
    // each parent param set to the next generateStaticParams, static segments
    // included (build/static-paths/app.ts generateRouteStaticParams).
    const child = mockRoute("/:lang/:category/details/more", {
      layoutPrefixes: [
        "/:lang",
        "/:lang/:category",
        "/:lang/:category/details",
        "/:lang/:category/details/more",
      ],
    });
    const calls: Record<string, Record<string, string | string[]>[]> = {};
    const record =
      (key: string, result: Record<string, string>[]) =>
      async ({ params }: { params: Record<string, string | string[]> }) => {
        (calls[key] ??= []).push(params);
        return result;
      };
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]": record("lang", [{ lang: "en" }, { lang: "fr" }]),
      "layouts:[lang]/[category]": record("category", [{ category: "news" }]),
      "layouts:[lang]/[category]/details": record("details", [{ extra: "x" }]),
      // The route's own layout composes with its page instead.
      "layouts:[lang]/[category]/details/more": record("own", [{ own: "no" }]),
    };

    await expect(resolveParentParams(child, staticParamsMap)).resolves.toEqual([
      { lang: "en", category: "news", extra: "x" },
      { lang: "fr", category: "news", extra: "x" },
    ]);
    expect(calls.category).toEqual([{ lang: "en" }, { lang: "fr" }]);
    expect(calls.details).toEqual([
      { lang: "en", category: "news" },
      { lang: "fr", category: "news" },
    ]);
    expect(calls.own).toBeUndefined();
  });

  it("passes parent params through a layout that returns none", async () => {
    // Outside Cache Components, Next.js keeps each parent set when a later
    // generateStaticParams returns [] (build/static-paths/app.ts).
    const child = mockRoute("/:lang/section/:slug", {
      layoutPrefixes: ["/:lang", "/:lang/section"],
    });
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]": async () => [{ lang: "en" }],
      "layouts:[lang]/section": async () => [],
    };
    await expect(resolveParentParams(child, staticParamsMap)).resolves.toEqual([{ lang: "en" }]);
  });

  it("still calls later layouts with no parent params after an empty result", async () => {
    // With no parent sets, Next.js calls the next generateStaticParams once
    // with `{}` (build/static-paths/app.ts generateRouteStaticParams).
    const child = mockRoute("/:lang/section/:category/:slug", {
      layoutPrefixes: ["/:lang/section", "/:lang/section/:category"],
    });
    const categoryCalls: Record<string, string | string[]>[] = [];
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]/section": async () => [],
      "layouts:[lang]/section/[category]": async ({ params }) => {
        categoryCalls.push(params);
        return [{ lang: "en", category: "news" }];
      },
    };
    await expect(resolveParentParams(child, staticParamsMap)).resolves.toEqual([
      { lang: "en", category: "news" },
    ]);
    expect(categoryCalls).toEqual([{}]);
  });

  it("rejects a layout that returns no params under static export", async () => {
    // With output: "export", Next.js fails any generateStaticParams that
    // returns [] before passing parent sets through (build/static-paths/app.ts
    // callGenerateStaticParams).
    const child = mockRoute("/:lang/section/:slug", {
      layoutPrefixes: ["/:lang", "/:lang/section"],
    });
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]": async () => [{ lang: "en" }],
      "layouts:[lang]/section": async () => [],
    };
    await expect(
      resolveParentParams(child, staticParamsMap, { staticExport: true }),
    ).rejects.toThrow(
      'Page "/:lang/section/:slug" returned an empty array from "generateStaticParams()". With "output: export", at least one route must be generated.',
    );
  });

  it("gives an App Route handler no layout params", async () => {
    // Next.js builds a route handler's segments from route.ts alone
    // (collectAppRouteSegments), so its layouts never supply params.
    const handler: AppRoute = {
      ...mockRoute("/:lang/api/:id", { layoutPrefixes: ["/:lang", "/:lang/api"] }),
      pagePath: null,
      routePath: "/app/[lang]/api/[id]/route.ts",
    };
    const staticParamsMap: StaticParamsMap = {
      "layouts:[lang]": async () => [{ lang: "fr" }],
      "layouts:[lang]/api": async () => [{ extra: "x" }],
    };
    await expect(resolveParentParams(handler, staticParamsMap)).resolves.toEqual([]);
  });

  it("resolves two levels of parent dynamic segments", async () => {
    const child = mockRoute("/a/:b/c/:d/:e", { layoutPrefixes: ["/a/:b", "/a/:b/c/:d"] });
    const staticParamsMap: StaticParamsMap = {
      "layouts:a/[b]": async () => [{ b: "1" }, { b: "2" }],
      "layouts:a/[b]/c/[d]": async ({ params }) => {
        if (params.b === "1") return [{ d: "x" }];
        return [{ d: "y" }, { d: "z" }];
      },
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([
      { b: "1", d: "x" },
      { b: "2", d: "y" },
      { b: "2", d: "z" },
    ]);
  });

  it("skips static segments between dynamic parents", async () => {
    const child = mockRoute("/shop/:category/details/:item", {
      layoutPrefixes: ["/shop/:category"],
    });
    const staticParamsMap: StaticParamsMap = {
      "layouts:shop/[category]": async () => [{ category: "shoes" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "shoes" }]);
  });

  it("returns empty array for a fully static route", async () => {
    const route = mockRoute("/about/contact");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("returns empty array for a single-segment dynamic route", async () => {
    const route = mockRoute("/:id");
    const result = await resolveParentParams(route, {});
    expect(result).toEqual([]);
  });

  it("resolves parent with catch-all child segment", async () => {
    const child = mockRoute("/shop/:category/:rest+", { layoutPrefixes: ["/shop/:category"] });
    const staticParamsMap: StaticParamsMap = {
      "layouts:shop/[category]": async () => [{ category: "electronics" }],
    };
    const result = await resolveParentParams(child, staticParamsMap);
    expect(result).toEqual([{ category: "electronics" }]);
  });
});
