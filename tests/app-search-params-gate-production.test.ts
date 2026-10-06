// Production cache-candidate renders of useSearchParams(), through real Flight
// and SSR. Inside Suspense, the server renders the fallback and the page is
// stored for every query; outside Suspense, a static route fails with a 500.
// Ported from Next.js:
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-static/app-static.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/missing-suspense-with-csr-bailout/missing-suspense-with-csr-bailout.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-search-params-gate");
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const DATA_URL_GLOBAL = "__SEARCH_PARAMS_GATE_DATA_URL__";
const DATA_REQUESTS_GLOBAL = "__SEARCH_PARAMS_GATE_DATA_REQUESTS__";
const EVENTS_GLOBAL = "__SEARCH_PARAMS_GATE_EVENTS__";
const CACHE_HANDLER_KEY = Symbol.for("vinext.cacheHandler");
const RSC_REQUEST: RequestInit = { headers: { Accept: "text/x-component", RSC: "1" } };
// Cache writes land after the response body ends, within this window.
const CACHE_WRITE_WINDOW_MS = 2_000;

type PageResponse = {
  body: string;
  cache: string | null;
  cacheControl: string;
  contentType: string;
  status: number;
};

// The production server runs in this process, so its cache is the memory
// cache handler it registered on globalThis. Returns every stored key for the
// pathname, HTML or RSC, with or without a query.
function storedKeys(pathname: string): string[] {
  const store: unknown = Reflect.get(Reflect.get(globalThis, CACHE_HANDLER_KEY) ?? {}, "store");
  if (!(store instanceof Map)) throw new Error("Expected the server's memory cache handler");
  return [...store.keys()].filter(
    (key): key is string =>
      typeof key === "string" &&
      (key.endsWith(`:${pathname}`) ||
        key.includes(`:${pathname}:`) ||
        key.includes(`:${pathname}?`)),
  );
}

function testIdText(html: string, testId: string): string | undefined {
  return html.match(new RegExp(`data-testid="${testId}"[^>]*>(?:<!--[^>]*-->)*([^<]*)<`))?.[1];
}

// Copies the fixture with a node_modules of its own, so the fixture's library
// is installed like a real package beside the workspace's dependencies.
function createFixture(): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-search-params-gate-"));
  try {
    fs.cpSync(FIXTURE_SOURCE_DIR, fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const nodeModules = path.join(fixtureDir, "node_modules");
    fs.mkdirSync(nodeModules);
    for (const entry of fs.readdirSync(ROOT_NODE_MODULES)) {
      if (entry.startsWith(".vite")) continue;
      const source = path.join(ROOT_NODE_MODULES, entry);
      const target = path.join(nodeModules, entry);
      // A junction can only target a directory; pnpm's state files are copied.
      if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, target, "junction");
      else fs.copyFileSync(source, target);
    }
    fs.renameSync(
      path.join(fixtureDir, "gate-suspense-lib"),
      path.join(nodeModules, "gate-suspense-lib"),
    );
    return fixtureDir;
  } catch (error) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    throw error;
  }
}

describe("useSearchParams() in production cache-candidate renders", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = createFixture();
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    Reflect.set(globalThis, DATA_URL_GLOBAL, `${baseUrl}/api/client-data`);
  }, 120_000);

  afterAll(() => {
    Reflect.deleteProperty(globalThis, DATA_URL_GLOBAL);
    Reflect.deleteProperty(globalThis, DATA_REQUESTS_GLOBAL);
    Reflect.deleteProperty(globalThis, EVENTS_GLOBAL);
    server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function get(pathname: string, init?: RequestInit): Promise<PageResponse> {
    const response = await fetch(new URL(pathname, baseUrl), init);
    return {
      body: await response.text(),
      cache: response.headers.get("x-vinext-cache"),
      cacheControl: response.headers.get("cache-control") ?? "",
      contentType: response.headers.get("content-type") ?? "",
      status: response.status,
    };
  }

  // The write lands after the response body ends, so poll for the stored entry.
  async function getStored(pathname: string): Promise<PageResponse> {
    const deadline = Date.now() + CACHE_WRITE_WINDOW_MS;
    let response = await get(pathname);
    while (response.cache !== "HIT" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await get(pathname);
    }
    return response;
  }

  // Asserts a wrapped useSearchParams() renders its fallback, not the query,
  // and that the page is stored and served to a request with another query.
  // `afterMiss` runs once the initial MISS body has been read, before any
  // polling request can render the page again. React can render a suspended
  // subtree more than once, so callers check how the MISS's events begin.
  async function expectStoredFallback(
    pathname: string,
    afterMiss?: () => void,
  ): Promise<PageResponse> {
    const [firstQuery, secondQuery] = [crypto.randomUUID(), crypto.randomUUID()];
    const miss = await get(`${pathname}?q=${firstQuery}`);
    afterMiss?.();
    const hit = await getStored(`${pathname}?q=${secondQuery}`);

    expect(miss.status).toBe(200);
    expect(miss.cache).toBe("MISS");
    expect(hit.status).toBe(200);
    expect(hit.cache).toBe("HIT");
    // The HTML and RSC entries are stored without the query, which shows
    // storedKeys() reads the cache the server writes to.
    expect(storedKeys(pathname).sort()).toEqual([
      expect.stringMatching(new RegExp(`:${pathname}:html$`)),
      expect.stringMatching(new RegExp(`:${pathname}:rsc$`)),
    ]);
    // Every fixture renders its marker outside the boundary, so a missing one
    // can't make two separate renders compare equal.
    expect(testIdText(miss.body, "render-id")).toBeTruthy();
    expect(testIdText(hit.body, "render-id")).toBe(testIdText(miss.body, "render-id"));
    for (const { body } of [miss, hit]) {
      expect(testIdText(body, "search-fallback")).toBe("fallback");
      expect(body).not.toContain('data-testid="search-value"');
      expect(body).not.toContain(firstQuery);
      expect(body).not.toContain(secondQuery);
    }
    return miss;
  }

  // Waits out the write window, then asserts the server's cache holds no HTML
  // or RSC entry for the pathnames, with or without the query.
  async function expectNoStoredEntries(pathnames: ReadonlySet<string>): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, CACHE_WRITE_WINDOW_MS));
    for (const pathname of pathnames) expect(storedKeys(pathname), pathname).toEqual([]);
  }

  // Asserts the server's cache holds no entry for the URLs' pathnames, and
  // that repeating the URLs doesn't HIT. The read path can reject a stored
  // entry, so a miss alone can't show nothing was written. The repeats render
  // again and can schedule their own writes, so the cache is checked again
  // once their write window has passed.
  async function expectStillUnstored(
    urls: readonly string[],
    rscUrls: readonly string[] = [],
  ): Promise<void> {
    const pathnames = new Set(
      [...urls, ...rscUrls].map((url) => new URL(url, baseUrl).pathname.replace(/\.rsc$/, "")),
    );
    await expectNoStoredEntries(pathnames);
    for (const [url, init] of [
      ...urls.map((url) => [url, undefined] as const),
      ...rscUrls.map((url) => [url, RSC_REQUEST] as const),
    ]) {
      const later = await get(url, init);
      expect(later.cache, url).not.toBe("HIT");
      expect(later.cacheControl, url).toContain("no-store");
      if (init) expect(later.contentType, url).toContain("text/x-component");
    }
    await expectNoStoredEntries(pathnames);
  }

  // Asserts a page renders the real query on every request and is never stored.
  async function expectRealValuesNeverStored(pathname: string): Promise<void> {
    const [firstQuery, secondQuery] = [crypto.randomUUID(), crypto.randomUUID()];
    const urls = [`${pathname}?q=${firstQuery}`, `${pathname}?q=${secondQuery}`];
    const first = await get(urls[0]);
    const second = await get(urls[1]);

    for (const [response, query] of [
      [first, firstQuery],
      [second, secondQuery],
    ] as const) {
      expect(response.status).toBe(200);
      expect(response.cache).not.toBe("HIT");
      expect(response.cacheControl).toContain("no-store");
      expect(testIdText(response.body, "search-value")).toBe(query);
      expect(response.body).not.toContain('data-testid="search-fallback"');
    }
    expect(testIdText(second.body, "render-id")).not.toBe(testIdText(first.body, "render-id"));
    // An RSC request renders the page without SSR, so it's checked on its own.
    const rscUrl = `${pathname}.rsc?q=${crypto.randomUUID()}`;
    const rsc = await get(rscUrl, RSC_REQUEST);
    expect(rsc.status).toBe(200);
    // A Flight response, not HTML, so the RSC render path and its writes run.
    expect(rsc.contentType).toContain("text/x-component");
    expect(rsc.cache).not.toBe("HIT");
    expect(rsc.cacheControl).toContain("no-store");
    await expectStillUnstored(urls, [rscUrl]);
  }

  describe("settle timing: the subtree reading the query resolves late", () => {
    it("loaded as a module no client reference preload covers, after rendering starts", async () => {
      const events: string[] = [];
      Reflect.set(globalThis, EVENTS_GLOBAL, events);
      // The initial MISS's render reaches the hook after the module loads,
      // before a polling request can render the page again.
      await expectStoredFallback("/settle/late-module", () => {
        expect(events.slice(0, 4)).toEqual([
          "render-started",
          "module-evaluated",
          "module-resolved",
          "hook-read",
        ]);
      });
    });

    it("loaded through React.lazy", async () => {
      const events: string[] = [];
      Reflect.set(globalThis, EVENTS_GLOBAL, events);
      // The initial MISS's render reaches the hook after the module loads.
      await expectStoredFallback("/settle/lazy", () => {
        expect(events.slice(0, 2)).toEqual(["lazy-resolved", "lazy-hook-read"]);
      });
    });

    it("loaded through next/dynamic", async () => {
      const events: string[] = [];
      Reflect.set(globalThis, EVENTS_GLOBAL, events);
      // The initial MISS's render reaches the hook after the module loads.
      await expectStoredFallback("/settle/next-dynamic", () => {
        expect(events.slice(0, 2)).toEqual(["next-dynamic-resolved", "next-dynamic-hook-read"]);
      });
    });

    it("suspended on a client fetch", async () => {
      const events: string[] = [];
      Reflect.set(globalThis, EVENTS_GLOBAL, events);
      // The initial MISS's render reaches the hook after its data resolves.
      await expectStoredFallback("/settle/client-fetch", () => {
        expect(events.slice(0, 2)).toEqual(["client-fetch-resolved", "client-fetch-hook-read"]);
      });
      // The miss's SSR fetched the data; the hit ran no code.
      expect(Reflect.get(globalThis, DATA_REQUESTS_GLOBAL)).toBe(1);
    });

    it("renders the real query in a client page that reads searchParams under loading.tsx, and never stores it", async () => {
      const [firstQuery, secondQuery] = [crypto.randomUUID(), crypto.randomUUID()];
      const urls = [`/settle/client-page?q=${firstQuery}`, `/settle/client-page?q=${secondQuery}`];
      const first = await get(urls[0]);
      const second = await get(urls[1]);

      for (const [response, query] of [
        [first, firstQuery],
        [second, secondQuery],
      ] as const) {
        expect(response.status).toBe(200);
        expect(response.cache).not.toBe("HIT");
        expect(response.cacheControl).toContain("no-store");
        expect(testIdText(response.body, "page-search-param")).toBe(query);
        // The page's own read makes the render dynamic. Its wrapped
        // useSearchParams() gets the real query when the render is known to be
        // dynamic first, or else keeps the fallback in a response that isn't
        // stored (row 12c).
        const searchValue = testIdText(response.body, "search-value");
        if (searchValue === undefined) {
          expect(testIdText(response.body, "search-fallback")).toBe("fallback");
        } else {
          expect(searchValue).toBe(query);
        }
      }
      await expectStillUnstored(urls);
    });
  });

  describe("wrapped useSearchParams() bails out and the page is stored when the boundary is in", () => {
    it("a client component", async () => {
      await expectStoredFallback("/boundary/client");
    });

    it("loading.tsx", async () => {
      await expectStoredFallback("/boundary/loading");
    });

    it("a library component", async () => {
      await expectStoredFallback("/boundary/library");
    });

    it("a page whose shell is also blocked by a slow client component", async () => {
      const miss = await expectStoredFallback("/boundary/slow-shell");
      expect(testIdText(miss.body, "slow-client")).toBe("slow-ready");
    });
  });

  describe("useSearchParams() outside Suspense", () => {
    it("fails a static route with a 500 and stores nothing, even with an error.tsx", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const urls = [crypto.randomUUID(), crypto.randomUUID()].map(
          (query) => `/missing/error-boundary?q=${query}`,
        );
        for (const url of urls) {
          const response = await get(url);
          expect(response.status).toBe(500);
          expect(response.cache).not.toBe("HIT");
          expect(response.cacheControl).toContain("no-store");
          expect(response.body).not.toContain('data-testid="error-boundary"');
        }
        await expectStillUnstored(urls);
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining(
            'useSearchParams() should be wrapped in a suspense boundary at page "/missing/error-boundary"',
          ),
        );
      } finally {
        consoleError.mockRestore();
      }
    });

    it("renders the real query on a dynamic-segment route without generateStaticParams", async () => {
      await expectRealValuesNeverStored("/missing/dynamic-segment/a");
    });

    it("renders the real query on a route a server component makes dynamic", async () => {
      await expectRealValuesNeverStored("/missing/server-dynamic");
    });
  });
});
