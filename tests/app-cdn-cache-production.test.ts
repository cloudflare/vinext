import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import vinext from "../packages/vinext/src/index.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/cdn-late-dynamic");

type AppHandler = (request: Request, env: unknown) => Promise<Response>;

function responseIsEdgeCacheable(response: Response): boolean {
  const policy = response.headers.get("cdn-cache-control") ?? "";
  return /(?:^|,)\s*public\b/.test(policy) && !/\b(?:no-store|no-cache|private)\b/.test(policy);
}

function createWorkersLikeEdge(handler: AppHandler) {
  const entries = new Map<string, Response>();
  let originRequests = 0;

  return {
    get originRequests() {
      return originRequests;
    },
    async fetch(request: Request): Promise<Response> {
      const cacheKey = new URL(request.url).pathname;
      const cached = entries.get(cacheKey);
      if (cached) return cached.clone();

      originRequests += 1;
      const response = await handler(request, {});
      const buffered = new Response(await response.arrayBuffer(), response);
      if (responseIsEdgeCacheable(buffered)) {
        entries.set(cacheKey, buffered.clone());
      }
      return buffered;
    },
  };
}

describe("App Router production responses with a CDN-managed cache", () => {
  let handler: AppHandler;
  let outputRoot: string;
  let ioServer: http.Server;

  beforeAll(async () => {
    let ioRequests = 0;
    ioServer = http.createServer((request, response) => {
      ioRequests += 1;
      const delay = new URL(request.url ?? "/", "http://localhost").searchParams.get("delay");
      setTimeout(() => response.end(`io-${ioRequests}`), delay === "750" ? 750 : 75);
    });
    await new Promise<void>((resolve, reject) => {
      ioServer.once("error", reject);
      ioServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = ioServer.address();
    if (!address || typeof address === "string") throw new Error("I/O server did not bind");
    process.env.TEST_CDN_LATE_DYNAMIC_IO_URL = `http://127.0.0.1:${address.port}/data`;

    outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-cdn-late-dynamic-"));
    const rscOutDir = path.join(outputRoot, "server");
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [
        vinext({
          appDir: FIXTURE_DIR,
          cache: { cdn: cdnAdapter() },
          rscOutDir,
          ssrOutDir: path.join(rscOutDir, "ssr"),
          clientOutDir: path.join(outputRoot, "client"),
        }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(outputRoot, "node_modules"),
    );

    const entry = path.join(rscOutDir, "index.js");
    const built = (await import(pathToFileURL(entry).href)) as {
      default: AppHandler;
    };
    if (typeof built.default !== "function") {
      throw new Error(`Unexpected RSC entry exports: ${Object.keys(built).join(",")}`);
    }
    handler = built.default;
  }, 120_000);

  afterAll(async () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    delete process.env.TEST_CDN_LATE_DYNAMIC_IO_URL;
    await new Promise<void>((resolve, reject) => {
      ioServer.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(outputRoot, { force: true, recursive: true });
  });

  it("does not share a response personalized after deferred I/O", async () => {
    // Next.js likewise classifies cookie-dependent content behind Suspense as dynamic:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-metadata-streaming/app/fully-dynamic/page.tsx
    const edge = createWorkersLikeEdge(handler);

    const first = await edge.fetch(
      new Request("https://example.com/late-dynamic", {
        headers: { cookie: "session=user-a" },
      }),
    );
    const firstHtml = await first.text();
    expect(firstHtml).toContain('id="session"');
    expect(firstHtml).toContain("user-a");

    const second = await edge.fetch(
      new Request("https://example.com/late-dynamic", {
        headers: { cookie: "session=user-b" },
      }),
    );
    const secondHtml = await second.text();
    expect(secondHtml).toContain("user-b");
    expect(secondHtml).not.toContain("user-a");
    expect(edge.originRequests).toBe(2);
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(first.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("admits a deferred static response before promoting it to the edge", async () => {
    const edge = createWorkersLikeEdge(handler);

    const first = await edge.fetch(new Request("https://example.com/static"));
    expect(await first.text()).toContain("io-");
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(first.headers.get("cache-control")).toMatch(/no-store/);

    const second = await edge.fetch(new Request("https://example.com/static"));
    expect(await second.text()).toContain("io-");
    expect(second.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    await edge.fetch(new Request("https://example.com/static"));
    expect(edge.originRequests).toBe(2);
  });

  it("admits slow static HTML and RSC responses without elapsed-time cutoffs", async () => {
    // Ported from Next.js' tagged RSC revalidation coverage:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/revalidatetag-rsc/revalidatetag-rsc.test.ts
    const rscEdge = createWorkersLikeEdge(handler);
    const rscRequest = () =>
      new Request("https://example.com/slow-static.rsc", {
        headers: { accept: "text/x-component", rsc: "1" },
      });
    const rscStartedAt = performance.now();
    const firstRsc = await rscEdge.fetch(rscRequest());
    expect(performance.now() - rscStartedAt).toBeGreaterThanOrEqual(500);
    expect(await firstRsc.text()).toContain("io-");
    expect(firstRsc.headers.get("cdn-cache-control")).toBeNull();
    const admittedRsc = await rscEdge.fetch(rscRequest());
    expect(admittedRsc.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    expect(admittedRsc.headers.get("cache-tag")).toContain("post:slow-static");
    await rscEdge.fetch(rscRequest());
    expect(rscEdge.originRequests).toBe(2);

    const htmlEdge = createWorkersLikeEdge(handler);
    const firstHtml = await htmlEdge.fetch(new Request("https://example.com/slow-static"));
    expect(await firstHtml.text()).toContain("io-");
    expect(firstHtml.headers.get("cdn-cache-control")).toBeNull();
    const admittedHtml = await htmlEdge.fetch(new Request("https://example.com/slow-static"));
    expect(admittedHtml.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    await htmlEdge.fetch(new Request("https://example.com/slow-static"));
    expect(htmlEdge.originRequests).toBe(2);
  });

  it("does not share a deferred personalized RSC response", async () => {
    const edge = createWorkersLikeEdge(handler);

    const first = await edge.fetch(
      new Request("https://example.com/late-dynamic.rsc", {
        headers: { accept: "text/x-component", cookie: "session=rsc-user-a", rsc: "1" },
      }),
    );
    const firstPayload = await first.text();
    expect(firstPayload).toContain("rsc-user-a");

    const second = await edge.fetch(
      new Request("https://example.com/late-dynamic.rsc", {
        headers: { accept: "text/x-component", cookie: "session=rsc-user-b", rsc: "1" },
      }),
    );
    const secondPayload = await second.text();
    expect(secondPayload).toContain("rsc-user-b");
    expect(secondPayload).not.toContain("rsc-user-a");
    expect(edge.originRequests).toBe(2);
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(first.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("admits revalidate=false HTML and RSC responses before edge caching", async () => {
    const htmlEdge = createWorkersLikeEdge(handler);
    const firstHtml = await htmlEdge.fetch(new Request("https://example.com/revalidate-false"));
    expect(await firstHtml.text()).toContain("io-");
    expect(firstHtml.headers.get("cdn-cache-control")).toBeNull();
    const admittedHtml = await htmlEdge.fetch(new Request("https://example.com/revalidate-false"));
    expect(admittedHtml.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    await htmlEdge.fetch(new Request("https://example.com/revalidate-false"));
    expect(htmlEdge.originRequests).toBe(2);

    const rscEdge = createWorkersLikeEdge(handler);
    const rscRequest = () =>
      new Request("https://example.com/revalidate-false.rsc", {
        headers: { accept: "text/x-component", rsc: "1" },
      });
    const firstRsc = await rscEdge.fetch(rscRequest());
    expect(await firstRsc.text()).toContain("io-");
    // The HTML admission writes the paired RSC artifact, so this request can
    // promote it directly to the edge without another private render.
    expect(firstRsc.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    await rscEdge.fetch(rscRequest());
    expect(rscEdge.originRequests).toBe(1);
  });

  it("streams before late dynamic usage and keeps the fresh response private", async () => {
    const response = await Promise.race([
      handler(
        new Request("https://example.com/slow", {
          headers: { cookie: "session=slow-user" },
        }),
        {},
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("handler waited for the deferred render")), 500),
      ),
    ]);

    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(await response.text()).toContain("slow-user");
  });

  it("returns and can cancel a known-dynamic never-settling response", async () => {
    const startedAt = performance.now();
    const response = await Promise.race([
      handler(new Request("https://example.com/never"), {}),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("handler did not return")), 1000),
      ),
    ]);
    const responseCreatedAfter = performance.now() - startedAt;

    expect(responseCreatedAfter).toBeLessThan(500);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    await response.body?.cancel();
  });

  it("admits a large static response without a payload-size cutoff", async () => {
    const edge = createWorkersLikeEdge(handler);
    const first = await edge.fetch(new Request("https://example.com/large"));

    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect((await first.text()).length).toBeGreaterThan(1024 * 1024);
    const admitted = await edge.fetch(new Request("https://example.com/large"));
    expect(admitted.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);
    await edge.fetch(new Request("https://example.com/large"));
    expect(edge.originRequests).toBe(2);
  });
});
