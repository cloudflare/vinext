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

  it("edge-caches the Suspense bailout for ISR client search params", async () => {
    const edge = createWorkersLikeEdge(handler);
    const pathname = `/query-isr/query-${Date.now()}`;

    const attacker = await edge.fetch(
      new Request(`https://example.com${pathname}?q=EDGE_ATTACKER_PAYLOAD`),
    );
    const attackerHtml = await attacker.text();
    expect(attackerHtml).toContain('id="query-loading"');
    expect(attackerHtml).not.toContain("EDGE_ATTACKER_PAYLOAD");
    expect(attacker.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);

    const victim = await edge.fetch(new Request(`https://example.com${pathname}`));
    const victimHtml = await victim.text();
    expect(victimHtml).toBe(attackerHtml);
    expect(victimHtml).not.toContain("EDGE_ATTACKER_PAYLOAD");
    expect(edge.originRequests).toBe(1);
  });

  it("rejects query access while serializing server-inserted HTML", async () => {
    const edge = createWorkersLikeEdge(handler);
    const pathname = `/query-inserted-error/query-${Date.now()}`;

    await expect(
      edge.fetch(new Request(`https://example.com${pathname}?q=INSERTED_EDGE_ATTACKER`)),
    ).rejects.toThrow("Bail out to client-side rendering: useSearchParams()");
    await expect(edge.fetch(new Request(`https://example.com${pathname}`))).rejects.toThrow(
      "Bail out to client-side rendering: useSearchParams()",
    );
    expect(edge.originRequests).toBe(2);
  });

  it("rejects unbounded dynamic-error client search params", async () => {
    const edge = createWorkersLikeEdge(handler);
    const pathname = `/query-dynamic-error-unbounded/query-${Date.now()}`;

    const first = await edge.fetch(
      new Request(`https://example.com${pathname}?q=EDGE_ATTACKER_PAYLOAD`),
    );
    expect(first.status).toBe(500);
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(first.headers.get("cache-control")).toMatch(/no-store/);

    const second = await edge.fetch(new Request(`https://example.com${pathname}`));
    expect(second.status).toBe(500);
    expect(second.headers.get("cdn-cache-control")).toBeNull();
    expect(edge.originRequests).toBe(2);
  });

  it("edge-caches dynamic-error client search params as a Suspense bailout", async () => {
    const edge = createWorkersLikeEdge(handler);
    const pathname = `/query-dynamic-error/query-${Date.now()}`;

    const first = await edge.fetch(
      new Request(`https://example.com${pathname}?q=EDGE_ATTACKER_PAYLOAD`),
    );
    const firstHtml = await first.text();
    expect(firstHtml).toContain("query fallback");
    expect(firstHtml).not.toContain("EDGE_ATTACKER_PAYLOAD");
    expect(first.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);

    const second = await edge.fetch(new Request(`https://example.com${pathname}`));
    expect(await second.text()).toBe(firstHtml);
    expect(edge.originRequests).toBe(1);
  });

  it("still lets the edge cache a deferred response that remains static", async () => {
    const edge = createWorkersLikeEdge(handler);

    const first = await edge.fetch(new Request("https://example.com/static"));
    expect(await first.text()).toContain("io-");
    expect(first.headers.get("cdn-cache-control")).toMatch(/public, max-age=60/);

    const second = await edge.fetch(new Request("https://example.com/static"));
    expect(await second.text()).toContain("io-");
    expect(edge.originRequests).toBe(1);
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

  it("edge-caches revalidate=false HTML and RSC responses", async () => {
    const htmlEdge = createWorkersLikeEdge(handler);
    const firstHtml = await htmlEdge.fetch(new Request("https://example.com/revalidate-false"));
    expect(await firstHtml.text()).toContain("io-");
    expect(firstHtml.headers.get("cdn-cache-control")).toMatch(/public, max-age=31536000/);
    await htmlEdge.fetch(new Request("https://example.com/revalidate-false"));
    expect(htmlEdge.originRequests).toBe(1);

    const rscEdge = createWorkersLikeEdge(handler);
    const rscRequest = () =>
      new Request("https://example.com/revalidate-false.rsc", {
        headers: { accept: "text/x-component", rsc: "1" },
      });
    const firstRsc = await rscEdge.fetch(rscRequest());
    expect(await firstRsc.text()).toContain("io-");
    expect(firstRsc.headers.get("cdn-cache-control")).toMatch(/public, max-age=31536000/);
    await rscEdge.fetch(rscRequest());
    expect(rscEdge.originRequests).toBe(1);
  });

  it("returns a streaming no-store response when verification exceeds its deadline", async () => {
    const startedAt = performance.now();
    const response = await handler(
      new Request("https://example.com/slow", {
        headers: { cookie: "session=slow-user" },
      }),
      {},
    );
    const responseCreatedAfter = performance.now() - startedAt;

    expect(responseCreatedAfter).toBeLessThan(500);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(await response.text()).toContain("slow-user");
  });

  it("returns and can cancel a never-settling response", async () => {
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

  it("fails closed instead of buffering an oversized cache candidate", async () => {
    const response = await handler(new Request("https://example.com/large"), {});

    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    await response.body?.cancel();
  });
});
