import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type AppPageCacheOutcomeMetric,
  buildAppPageCacheTags,
  buildAppPageCachedResponse,
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
  readAppPageCacheResponse,
  readAppPageFallbackShellCacheResponse,
  scheduleAppPageRscCacheWrite,
} from "../packages/vinext/src/server/app-page-cache.js";
import {
  isrGet,
  isrSet,
  type AppPageCacheSetter,
  type ISRCacheEntry,
} from "../packages/vinext/src/server/isr-cache.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import type { RenderObservation } from "../packages/vinext/src/server/cache-proof.js";
import {
  MemoryCacheHandler,
  setCacheHandler,
  type CachedAppPageValue,
} from "../packages/vinext/src/shims/cache.js";
import type { CacheControlMetadata } from "../packages/vinext/src/shims/cache-handler.js";
import { markAppPprDynamicFallbackShellHtml } from "../packages/vinext/src/server/app-ppr-fallback-shell.js";
import { NEXT_ROUTER_STALE_TIME_HEADER } from "../packages/vinext/src/server/headers.js";
import {
  markClientTraceMetadataBlock,
  renderClientTraceMetadataTags,
} from "../packages/vinext/src/server/client-trace-metadata.js";
import { markFrameworkLinkHeaders } from "../packages/vinext/src/server/app-response-header-provenance.js";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { withEnvVar } from "./env-test-helpers.js";
import {
  buildQueryInvariantRenderObservation,
  buildSearchParamsReadRenderObservation,
  queryInvariantObservationBuilders,
  queryInvariantRegenObservations,
} from "./render-observation-test-helpers.js";

function createHeaderClearingCdnAdapter(): CdnCacheAdapter {
  return {
    ownsBackgroundRevalidation: false,
    async get() {
      return null;
    },
    async set() {},
    buildResponseHeaders(input) {
      return {
        "Cache-Control": input.pendingDynamicCheck
          ? "no-store, must-revalidate"
          : input.cacheControl,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      };
    },
    async revalidateTag() {},
  };
}

afterEach(() => setCdnCacheAdapter(new DefaultCdnCacheAdapter()));

function buildISRCacheEntry(
  value: CachedAppPageValue,
  isStale = false,
  cacheControl?: CacheControlMetadata,
): ISRCacheEntry {
  return {
    isStale,
    value: {
      cacheControl,
      lastModified: Date.now(),
      value,
    },
  };
}

function buildCachedAppPageValue(
  html: string,
  rscData?: ArrayBuffer,
  status?: number,
  renderObservation?: RenderObservation,
): CachedAppPageValue {
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html,
    rscData,
    headers: undefined,
    postponed: undefined,
    status,
  };
  if (renderObservation) {
    value.renderObservation = renderObservation;
  }
  return value;
}

describe("app page cache helpers", () => {
  it("builds implicit page cache tags with unique extra tags", () => {
    expect(buildAppPageCacheTags("/blog/hello", ["custom", "_N_T_/blog/layout"])).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/blog/layout",
      "_N_T_/blog/hello/layout",
      "_N_T_/blog/hello/page",
      "custom",
    ]);
  });

  it("builds cached HTML and RSC responses", async () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>", rscData, 201);

    const htmlResponse = buildAppPageCachedResponse(cachedValue, {
      cacheState: "HIT",
      expireSeconds: 300,
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.status).toBe(201);
    expect(htmlResponse?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(htmlResponse?.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(htmlResponse?.headers.get("x-vinext-cache")).toBe("HIT");
    // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    expect(htmlResponse?.headers.get("x-nextjs-cache")).toBe("HIT");
    await expect(htmlResponse?.text()).resolves.toBe("<h1>cached</h1>");

    const rscResponse = withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "compat-a", () =>
      buildAppPageCachedResponse(cachedValue, {
        cacheState: "STALE",
        expireSeconds: 300,
        isRscRequest: true,
        revalidateSeconds: 60,
      }),
    );
    expect(rscResponse?.headers.get("content-type")).toBe("text/x-component");
    expect(rscResponse?.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
    expect(rscResponse?.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
    expect(rscResponse?.headers.get("x-nextjs-cache")).toBe("STALE");
    expect(await rscResponse?.arrayBuffer()).toEqual(rscData);
  });

  it("replays the entry's client stale time on cache hits", async () => {
    // The claim was resolved by the render that produced these bytes and
    // persisted onto the entry. Replaying it is what keeps a warm hit from
    // serving identical output under a wider client-reuse window than the
    // fresh render that produced it.
    const rscData = new TextEncoder().encode("flight").buffer;
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>", rscData);

    const htmlResponse = buildAppPageCachedResponse(cachedValue, {
      cacheControl: { revalidate: 1, expire: 60, stale: 30 },
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    // `stale` exceeds `revalidate` in the `seconds` profile by design, so the
    // shared-cache window must not clamp the client-router bound.
    expect(htmlResponse?.headers.get(NEXT_ROUTER_STALE_TIME_HEADER)).toBe("30");

    const rscResponse = buildAppPageCachedResponse(cachedValue, {
      cacheControl: { revalidate: 1, expire: 60, stale: 30 },
      cacheState: "HIT",
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get(NEXT_ROUTER_STALE_TIME_HEADER)).toBe("30");
    // `stale` governs client-router reuse only; shared caches keep following
    // revalidate/expire, so it must not appear in Cache-Control.
    expect(htmlResponse?.headers.get("cache-control")).toBe(
      "s-maxage=1, stale-while-revalidate=59",
    );
  });

  it("replays the client stale time verbatim, unclamped by expire and entry age", () => {
    // Deliberate Next.js parity: the stored header is re-emitted unchanged on
    // every hit (app-page-runtime.ts replays cached headers verbatim), and the
    // cached HTML body embeds the same original value in its done-script, so
    // aging or clamping only this header would make one entry's two artifacts
    // disagree. `expire` is enforced server-side instead — entries past it are
    // blocking misses, never replayed.
    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheControl: { revalidate: 60, expire: 45, stale: 300 },
      cacheState: "STALE",
      isRscRequest: false,
      revalidateSeconds: 60,
    });

    expect(response?.headers.get(NEXT_ROUTER_STALE_TIME_HEADER)).toBe("300");
  });

  it("advertises no client stale time when the entry carries no claim", () => {
    // The `default` profile is { revalidate: 900, expire: 4294967294 } with no
    // `stale`. Synthesizing one from those would license ~136 years of client
    // reuse without a refresh; omitting the header leaves the client on its
    // configured experimental.staleTimes value.
    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheControl: { revalidate: 900, expire: 4294967294 },
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 900,
    });

    expect(response?.headers.get(NEXT_ROUTER_STALE_TIME_HEADER)).toBeNull();
  });

  it("merges middleware response headers into cached HTML responses", async () => {
    const middlewareHeaders = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      Vary: "Accept-Encoding",
      "X-Frame-Options": "DENY",
    });
    middlewareHeaders.append("Set-Cookie", "session=abc; Path=/; HttpOnly");

    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheState: "HIT",
      isRscRequest: false,
      middlewareHeaders,
      revalidateSeconds: 60,
    });

    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response?.headers.get("Set-Cookie")).toBe("session=abc; Path=/; HttpOnly");
    expect(response?.headers.get("Vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, Accept-Encoding`);
    expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response?.headers.get("X-Vinext-Cache")).toBe("HIT");
  });

  it("replays prerendered Link headers after middleware Link values", () => {
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>");
    cachedValue.headers = {
      link: "</font.woff2>; rel=preload; as=font",
    };

    const response = buildAppPageCachedResponse(cachedValue, {
      cacheState: "HIT",
      isRscRequest: false,
      middlewareHeaders: new Headers({ link: "</middleware.css>; rel=preload; as=style" }),
      revalidateSeconds: 60,
    });

    expect(response?.headers.get("link")).toBe(
      "</middleware.css>; rel=preload; as=style, </font.woff2>; rel=preload; as=font",
    );
  });

  it("merges middleware response headers into cached RSC responses", async () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const middlewareHeaders = new Headers({
      "Access-Control-Allow-Origin": "https://example.com",
      [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "middleware-compat",
      Vary: "Origin",
    });

    const response = withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "framework-compat", () =>
      buildAppPageCachedResponse(buildCachedAppPageValue("", rscData), {
        cacheState: "STALE",
        isRscRequest: true,
        middlewareHeaders,
        revalidateSeconds: 60,
      }),
    );

    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response?.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("framework-compat");
    expect(response?.headers.get("Vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, Origin`);
    expect(response?.headers.get("X-Vinext-Cache")).toBe("STALE");
    await expect(response?.arrayBuffer()).resolves.toEqual(rscData);
  });

  it("uses stored cache-control metadata instead of global config for cached HIT responses", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>");

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(cachedValue, false, { revalidate: 60, expire: 300 }),
      ),
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname) {
        return `rsc:${pathname}`;
      },
      isrSet: vi.fn(async () => {}),
      expireSeconds: 31_536_000,
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(),
      scheduleBackgroundRegeneration: vi.fn(),
    });

    expect(response?.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("emits static cache-control for cached indefinite app pages", async () => {
    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: Infinity,
    });

    expect(response?.headers.get("cache-control")).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
  });

  it("preserves legacy STALE headers when cached entries lack cache-control metadata", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>");

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet: vi.fn(async () => buildISRCacheEntry(cachedValue, true)),
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname) {
        return `rsc:${pathname}`;
      },
      isrSet: vi.fn(async () => {}),
      expireSeconds: 31_536_000,
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(async () => ({
        ...queryInvariantRegenObservations(),
        usedDynamicApi: false,
        html: "<h1>fresh</h1>",
        rscData: new ArrayBuffer(0),
        tags: [],
      })),
      scheduleBackgroundRegeneration: vi.fn(),
    });

    expect(response?.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
  });

  it("does not serve or background-regenerate hard-expired app pages", async () => {
    const scheduleBackgroundRegeneration = vi.fn();
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];
    const expiredEntry: ISRCacheEntry = {
      ...buildISRCacheEntry(buildCachedAppPageValue("<h1>expired</h1>"), true),
      isExpired: true,
    };

    const response = await readAppPageCacheResponse({
      cleanPathname: "/expired",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet: vi.fn(async () => expiredEntry),
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname) {
        return `rsc:${pathname}`;
      },
      isrSet: vi.fn(async () => {}),
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(),
      scheduleBackgroundRegeneration,
    });

    expect(response).toBeNull();
    expect(scheduleBackgroundRegeneration).not.toHaveBeenCalled();
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/expired",
        outcome: "miss",
        reason: "expired",
      },
    ]);
  });

  it("falls back to 200 for falsy cached status values", () => {
    const response = buildAppPageCachedResponse(
      buildCachedAppPageValue("<h1>cached</h1>", undefined, 0),
      {
        cacheState: "HIT",
        isRscRequest: false,
        revalidateSeconds: 60,
      },
    );

    expect(response?.status).toBe(200);
  });

  it("uses middleware status for cached responses when middleware continues", () => {
    const response = buildAppPageCachedResponse(
      buildCachedAppPageValue("<h1>cached</h1>", undefined, 201),
      {
        cacheState: "HIT",
        isRscRequest: false,
        middlewareStatus: 202,
        revalidateSeconds: 60,
      },
    );

    expect(response?.status).toBe(202);
  });

  it("returns null when a cached entry lacks the requested HTML or RSC payload", () => {
    const htmlOnly = buildCachedAppPageValue("<h1>cached</h1>");
    const rscOnly = buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer);

    expect(
      buildAppPageCachedResponse(htmlOnly, {
        cacheState: "HIT",
        isRscRequest: true,
        revalidateSeconds: 60,
      }),
    ).toBeNull();
    expect(
      buildAppPageCachedResponse(rscOnly, {
        cacheState: "HIT",
        isRscRequest: false,
        revalidateSeconds: 60,
      }),
    ).toBeNull();
  });

  it("emits the `x-edge-runtime: 1` marker on cached responses for edge-runtime routes", () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cached = buildCachedAppPageValue("<h1>cached</h1>", rscData);

    const htmlResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isEdgeRuntime: true,
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.headers.get("x-edge-runtime")).toBe("1");

    const rscResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isEdgeRuntime: true,
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on cached responses for nodejs-runtime routes", () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cached = buildCachedAppPageValue("<h1>cached</h1>", rscData);

    const htmlResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.headers.get("x-edge-runtime")).toBeNull();

    const rscResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get("x-edge-runtime")).toBeNull();
  });

  it("returns cached HIT responses and clears request state", async () => {
    let didClearRequestContext = false;
    const middlewareHeaders = new Headers({ "X-From-Middleware": "hit" });
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>cached</h1>"));
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      middlewareHeaders,
      middlewareStatus: 203,
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response?.headers.get("x-from-middleware")).toBe("hit");
    expect(response?.status).toBe(203);
    await expect(response?.text()).resolves.toBe("<h1>cached</h1>");
    expect(didClearRequestContext).toBe(true);
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/cached",
        outcome: "hit",
        reason: "served",
      },
    ]);
  });

  it("treats unproofed cached HIT responses as misses for query-bearing requests", async () => {
    let didRenderFresh = false;
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        throw new Error("unproofed query cache hit should not clear request context");
      },
      hasRequestSearchParams: true,
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>cached empty query</h1>"));
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        didRenderFresh = true;
        return {
          ...queryInvariantRegenObservations(),
          usedDynamicApi: false,
          html: "<h1>fresh</h1>",
          rscData: new ArrayBuffer(0),
          tags: [],
        };
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response).toBeNull();
    expect(didRenderFresh).toBe(false);
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/cached",
        outcome: "miss",
        reason: "query-variant-unproven",
      },
    ]);
  });

  it("serves cached HIT responses for query-bearing requests with negative searchParams proof", async () => {
    let didClearRequestContext = false;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      hasRequestSearchParams: true,
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue(
            "<h1>cached</h1>",
            undefined,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
        );
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response?.text()).resolves.toBe("<h1>cached</h1>");
    expect(didClearRequestContext).toBe(true);
  });

  it("returns cached HIT responses when the cache outcome recorder throws", async () => {
    let didClearRequestContext = false;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>cached</h1>"));
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome() {
        throw new Error("metrics sink unavailable");
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response?.text()).resolves.toBe("<h1>cached</h1>");
    expect(didClearRequestContext).toBe(true);
  });

  it("bypasses persistent RSC cache reads for mounted-slot variants", async () => {
    const debugCalls: Array<[string, string]> = [];
    const isrGet = vi.fn();
    const isrRscKey = vi.fn();

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {},
      isRscRequest: true,
      isrGet,
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey,
      async isrSet() {},
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      mountedSlotsHeader: "slot:auth:/",
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("read helper should not render directly");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response).toBeNull();
    expect(isrGet).not.toHaveBeenCalled();
    expect(isrRscKey).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([["MISS (mounted slots RSC variant)", "/cached"]]);
  });

  it("does not serve or regenerate stale mounted-slot RSC cache entries", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrRscKey = vi.fn(
      (pathname: string, mountedSlotsHeader?: string | null) =>
        `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`,
    );
    const isrGet = vi.fn();
    const isrSet = vi.fn();

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale",
      clearRequestContext() {},
      isRscRequest: true,
      isrGet,
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey,
      isrSet,
      mountedSlotsHeader: "slot:auth:/",
      expireSeconds: 300,
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("read helper should not render directly");
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response).toBeNull();
    expect(isrGet).not.toHaveBeenCalled();
    expect(isrRscKey).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
    expect(scheduledRegenerations).toHaveLength(0);
  });

  it("does not dedup mounted-slot RSC regeneration by a persistent cache key", async () => {
    const scheduledKeys: string[] = [];
    const isrGet = vi.fn();

    const response = await readAppPageCacheResponse({
      cleanPathname: "/parallel",
      clearRequestContext() {},
      isRscRequest: true,
      isrGet,
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet() {},
      mountedSlotsHeader: "slot:auth:/",
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("read helper should not render directly");
      },
      scheduleBackgroundRegeneration(key) {
        scheduledKeys.push(key);
      },
    });

    expect(response).toBeNull();
    expect(isrGet).not.toHaveBeenCalled();
    expect(scheduledKeys).toEqual([]);
  });

  it("serves stale HTML entries and regenerates HTML plus canonical RSC cache keys", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrHtmlKey = vi.fn((pathname: string) => "html:" + pathname);
    const isrSetCalls: Array<{
      key: string;
      expireSeconds: number | undefined;
      linkHeader: string | string[] | undefined;
      revalidateSeconds: number | false;
    }> = [];
    const rscData = new TextEncoder().encode("fresh-flight").buffer;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale-html",
      clearRequestContext() {},
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>stale</h1>"), true);
      },
      isrHtmlKey,
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet(key, data, policy) {
        isrSetCalls.push({
          key,
          expireSeconds: policy.cacheControl.expire,
          linkHeader: data.headers?.link,
          revalidateSeconds: policy.cacheControl.revalidate,
        });
      },
      mountedSlotsHeader: "slot:forged:/",
      expireSeconds: 300,
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          cacheControl: { revalidate: 10, expire: 20 },
          ...queryInvariantRegenObservations(),
          usedDynamicApi: false,
          html: "<h1>fresh</h1>",
          linkHeader: "</fresh.css>; rel=preload; as=style",
          rscData,
          tags: ["/stale-html", "_N_T_/stale-html"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    await scheduledRegenerations[0]();
    expect(isrHtmlKey).toHaveBeenCalledOnce();
    expect(isrSetCalls).toEqual([
      {
        key: "rsc:/stale-html:none",
        expireSeconds: 20,
        linkHeader: undefined,
        revalidateSeconds: 10,
      },
      {
        key: "html:/stale-html",
        expireSeconds: 20,
        linkHeader: "</fresh.css>; rel=preload; as=style",
        revalidateSeconds: 10,
      },
    ]);
  });

  it.each([
    { isRscRequest: false, unproven: "html" },
    { isRscRequest: false, unproven: "rsc" },
    { isRscRequest: true, unproven: "rsc" },
  ] as const)(
    "skips regeneration writes when the $unproven render may have read searchParams (RSC request: $isRscRequest)",
    async ({ isRscRequest, unproven }) => {
      const scheduledRegenerations: Array<() => Promise<void>> = [];
      const isrSet = vi.fn(async () => {});

      const response = await readAppPageCacheResponse({
        cleanPathname: "/stale",
        clearRequestContext() {},
        isRscRequest,
        async isrGet() {
          return buildISRCacheEntry(
            buildCachedAppPageValue("<h1>stale</h1>", new ArrayBuffer(0)),
            true,
          );
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        isrSet,
        revalidateSeconds: 60,
        async renderFreshPageForCache() {
          return {
            ...queryInvariantRegenObservations(),
            usedDynamicApi: false,
            [`${unproven}RenderObservation`]: buildSearchParamsReadRenderObservation(),
            html: "<h1>fresh</h1>",
            rscData: new ArrayBuffer(0),
            tags: [],
          };
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRegenerations.push(renderFn);
        },
      });

      expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
      await scheduledRegenerations[0]();
      expect(isrSet).not.toHaveBeenCalled();
    },
  );

  it("preserves route-level revalidate when regenerated App page fetches live longer", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrSetCalls: Array<{
      key: string;
      expireSeconds: number | undefined;
      revalidateSeconds: number | false;
    }> = [];
    const rscData = new TextEncoder().encode("fresh-flight").buffer;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/config-and-fetch-revalidate",
      clearRequestContext() {},
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>stale</h1>"), true);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet(key, _data, policy) {
        isrSetCalls.push({
          key,
          expireSeconds: policy.cacheControl.expire,
          revalidateSeconds: policy.cacheControl.revalidate,
        });
      },
      revalidateSeconds: 3,
      async renderFreshPageForCache() {
        return {
          cacheControl: { revalidate: 9 },
          ...queryInvariantRegenObservations(),
          usedDynamicApi: false,
          html: "<h1>fresh</h1>",
          rscData,
          tags: ["/config-and-fetch-revalidate", "_N_T_/config-and-fetch-revalidate"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    await scheduledRegenerations[0]();

    expect(isrSetCalls).toEqual([
      {
        key: "rsc:/config-and-fetch-revalidate:none",
        expireSeconds: undefined,
        revalidateSeconds: 3,
      },
      {
        key: "html:/config-and-fetch-revalidate",
        expireSeconds: undefined,
        revalidateSeconds: 3,
      },
    ]);
  });

  // Next.js pairs expireTime only with a finite revalidate, so a regenerated
  // revalidate = false entry keeps no expire unless a cacheLife sets one.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/index.ts#L3035-L3058
  for (const renderCacheControl of [undefined, { revalidate: Infinity, expire: 600 }]) {
    it(`regenerates a revalidate = false App page ${renderCacheControl ? "with its cacheLife expire" : "without the route expireTime"}`, async () => {
      const scheduledRegenerations: Array<() => Promise<void>> = [];
      const isrSetCalls: Array<[string, CacheControlMetadata]> = [];

      await readAppPageCacheResponse({
        cleanPathname: "/static",
        clearRequestContext() {},
        isRscRequest: false,
        async isrGet() {
          return buildISRCacheEntry(buildCachedAppPageValue("<h1>stale</h1>"), true, {
            revalidate: Infinity,
          });
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key, _data, policy) {
          isrSetCalls.push([key, policy.cacheControl]);
        },
        expireSeconds: 31_536_000,
        revalidateSeconds: Infinity,
        async renderFreshPageForCache() {
          return {
            cacheControl: renderCacheControl,
            ...queryInvariantRegenObservations(),
            html: "<h1>fresh</h1>",
            rscData: new TextEncoder().encode("fresh-flight").buffer,
            tags: ["/static", "_N_T_/static"],
          };
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRegenerations.push(renderFn);
        },
      });
      await scheduledRegenerations[0]();

      const cacheControl = renderCacheControl
        ? { revalidate: Infinity, expire: 600 }
        : { revalidate: Infinity };
      expect(isrSetCalls).toEqual([
        ["rsc:/static", cacheControl],
        ["html:/static", cacheControl],
      ]);
    });
  }

  it("serves stale static fallback shells without regenerating the shared shell key", async () => {
    const debugCalls: Array<[string, string]> = [];

    const response = await readAppPageFallbackShellCacheResponse({
      clearRequestContext() {},
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue("<html><head></head><body>stale shell</body></html>"),
          true,
          { revalidate: 60, expire: 300 },
        );
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      fallbackPathname: "/en/blog/[slug]",
      expireSeconds: 300,
      middlewareHeaders: new Headers({ "X-From-Middleware": "yes" }),
      revalidateSeconds: 60,
      rewriteHtml(html) {
        return html.replace("stale shell", "rewritten stale shell");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    expect(response?.headers.get("x-from-middleware")).toBe("yes");
    await expect(response?.text()).resolves.toContain("rewritten stale shell");
    expect(debugCalls).toContainEqual(["STALE (fallback shell)", "/en/blog/[slug]"]);
  });

  it("does not serve a hard-expired static fallback shell", async () => {
    const clearRequestContext = vi.fn();
    const response = await readAppPageFallbackShellCacheResponse({
      clearRequestContext,
      async isrGet() {
        return {
          ...buildISRCacheEntry(
            buildCachedAppPageValue("<html><head></head><body>expired shell</body></html>"),
            true,
          ),
          isExpired: true,
        };
      },
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      fallbackPathname: "/en/blog/[slug]",
      revalidateSeconds: 60,
      rewriteHtml(html) {
        return html;
      },
    });

    expect(response).toBeNull();
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("falls through when a cached fallback shell requires request-time resume", async () => {
    const debugCalls: Array<[string, string]> = [];

    const response = await readAppPageFallbackShellCacheResponse({
      clearRequestContext() {
        throw new Error("should not clear request context when falling through");
      },
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue(
            markAppPprDynamicFallbackShellHtml(
              "<html><head></head><body>dynamic shell</body></html>",
            ),
          ),
        );
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      fallbackPathname: "/en/blog/[slug]",
      revalidateSeconds: 60,
      rewriteHtml(html) {
        return html;
      },
    });

    expect(response).toBeNull();
    expect(debugCalls).toContainEqual([
      "MISS (dynamic fallback shell requires resume)",
      "/en/blog/[slug]",
    ]);
  });

  it("still schedules stale regeneration when the stale payload is unusable for this request", async () => {
    const debugCalls: Array<[string, string]> = [];
    const scheduledRegenerations: Array<() => Promise<void>> = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale-html-miss",
      clearRequestContext() {
        throw new Error("should not clear request context when falling through");
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer),
          true,
        );
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          ...queryInvariantRegenObservations(),
          usedDynamicApi: false,
          html: "<h1>fresh</h1>",
          rscData: new TextEncoder().encode("fresh-flight").buffer,
          tags: ["/stale-html-miss", "_N_T_/stale-html-miss"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response).toBeNull();
    expect(scheduledRegenerations).toHaveLength(1);
    expect(debugCalls).toContainEqual(["STALE MISS (empty stale entry)", "/stale-html-miss"]);

    await expect(scheduledRegenerations[0]()).resolves.toBeUndefined();
  });

  it("falls through and logs on cache read errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/broken",
      clearRequestContext() {},
      isRscRequest: false,
      async isrGet() {
        throw new Error("cache failed");
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {},
    });

    expect(response).toBeNull();
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/broken",
        outcome: "miss",
        reason: "read-error",
      },
    ]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("records a miss when a cache key contains a non-app-page value", async () => {
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/wrong-kind",
      clearRequestContext() {
        throw new Error("should not clear request context when falling through");
      },
      isRscRequest: false,
      async isrGet() {
        return {
          isStale: false,
          value: {
            lastModified: Date.now(),
            value: {
              kind: "REDIRECT",
              props: {},
            },
          },
        };
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response).toBeNull();
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/wrong-kind",
        outcome: "miss",
        reason: "non-app-page-entry",
      },
    ]);
  });

  it("finalizes HTML responses by teeing the stream and writing HTML and RSC cache keys", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
      linkHeader: string | string[] | undefined;
      expireSeconds: number | undefined;
      revalidateSeconds: number | false;
      tags: string[];
    }> = [];
    const debugCalls: Array<[string, string]> = [];
    const rscData = new TextEncoder().encode("flight").buffer;

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>fresh</h1>", {
        status: 201,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          Link: "</fresh.css>; rel=preload; as=style",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: Promise.resolve(rscData),
        cleanPathname: "/fresh",
        consumeDynamicUsage() {
          return false;
        },
        getPageTags() {
          return ["/fresh", "_N_T_/fresh"];
        },
        isrDebug(event, detail) {
          debugCalls.push([event, detail]);
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key, data, policy) {
          isrSetCalls.push({
            key,
            html: data.html,
            hasRscData: Boolean(data.rscData),
            linkHeader: data.headers?.link,
            expireSeconds: policy.cacheControl.expire,
            revalidateSeconds: policy.cacheControl.revalidate,
            tags: policy.tags ?? [],
          });
        },
        expireSeconds: 300,
        revalidateSeconds: 60,
        linkHeader: "</fresh.css>; rel=preload; as=style",
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<h1>fresh</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual([
      {
        key: "html:/fresh",
        html: "<h1>fresh</h1>",
        hasRscData: false,
        linkHeader: "</fresh.css>; rel=preload; as=style",
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
      {
        key: "rsc:/fresh",
        html: "",
        hasRscData: true,
        linkHeader: undefined,
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
    ]);
    expect(debugCalls).toEqual([["HTML cache written", "html:/fresh"]]);
  });

  it("keeps route-identity-divergent HTML out of origin and CDN caches", async () => {
    const isrSet = vi.fn();
    const waitUntil = vi.fn();
    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>encoded catch-all</h1>", {
        headers: {
          "Cache-Control": "public, s-maxage=3600",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        bypassInterceptionContextCache: true,
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/about",
        consumeDynamicUsage: () => false,
        getPageTags: () => ["/about"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        isrSet,
        revalidateSeconds: 3600,
        linkHeader: null,
        waitUntil,
      },
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toContain("encoded catch-all");
    expect(isrSet).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("keeps config Link values before framework preloads on bypassed HTML", async () => {
    const rendered = new Response("<h1>encoded catch-all</h1>", {
      headers: { Link: '</framework.woff2>; rel="preload"; as="font"' },
    });
    markFrameworkLinkHeaders(rendered.headers, rendered.headers.get("link"));

    const response = finalizeAppPageHtmlCacheResponse(rendered, {
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      bypassInterceptionContextCache: true,
      capturedRscDataPromise: null,
      cleanPathname: "/about",
      consumeDynamicUsage: () => false,
      getPageTags: () => ["/about"],
      isrHtmlKey: (pathname) => `html:${pathname}`,
      isrRscKey: (pathname) => `rsc:${pathname}`,
      isrSet: vi.fn(),
      revalidateSeconds: 3600,
      linkHeader: rendered.headers.get("link"),
    });

    await finalizeAppRscResponse(response, new Request("https://example.com/about"), {
      basePath: "",
      configHeaders: [
        {
          source: "/about",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      requestContext: {
        cookies: {},
        headers: new Headers(),
        host: "example.com",
        query: new URLSearchParams(),
      },
    });

    expect(response.headers.get("link")).toBe(
      '</config>; rel="describedby", </framework.woff2>; rel="preload"; as="font"',
    );
  });

  it("keeps request trace metadata on the live response but not its shared cache copy", async () => {
    const marker = "private-render-marker";
    const authored = '<meta name="baggage" content="application-policy"/>';
    const injected = markClientTraceMetadataBlock(
      renderClientTraceMetadataTags([{ key: "baggage", value: "tenant=alice" }]),
      marker,
    );
    const pendingCacheWrites: Promise<void>[] = [];
    let storedHtml = "";

    const response = finalizeAppPageHtmlCacheResponse(
      new Response(`<head>${authored}${injected}</head><main>page</main>`),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: null,
        cleanPathname: "/traced",
        clientTraceMetadataMarker: marker,
        consumeDynamicUsage: () => false,
        getPageTags: () => ["/traced"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        async isrSet(_key, data) {
          storedHtml = data.html;
        },
        revalidateSeconds: 60,
        linkHeader: null,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    await expect(response.text()).resolves.toContain("tenant=alice");
    await pendingCacheWrites[0];
    expect(storedHtml).toBe(`<head>${authored}</head><main>page</main>`);
  });

  it("skips HTML and RSC cache writes when dynamic usage appears during stream rendering", async () => {
    setCdnCacheAdapter(createHeaderClearingCdnAdapter());
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();
    const options = {
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/dynamic-html",
      consumeDynamicUsage() {
        return true;
      },
      getPageTags() {
        return ["/dynamic-html", "_N_T_/dynamic-html"];
      },
      isrDebug(event: string, detail: string) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname: string) {
        return "html:" + pathname;
      },
      isrRscKey(pathname: string) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: 60,
      linkHeader: null,
      waitUntil(promise: Promise<void>) {
        pendingCacheWrites.push(promise);
      },
    };

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>personalized</h1>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "Cache-Tag": "/dynamic-html",
          "CDN-Cache-Control": "public, max-age=60",
          "Cloudflare-CDN-Cache-Control": "public, max-age=60",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      options,
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<h1>personalized</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["HTML cache write skipped (dynamic usage during render)", "html:/dynamic-html"],
    ]);
  });

  it("skips HTML and RSC cache writes when dynamic usage was captured before context cleanup", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>personalized</h1>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedDynamicUsageBeforeContextCleanup() {
          return true;
        },
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/dynamic-html-cleanup",
        consumeDynamicUsage() {
          return false;
        },
        getPageTags() {
          return ["/dynamic-html-cleanup", "_N_T_/dynamic-html-cleanup"];
        },
        isrDebug(event, detail) {
          debugCalls.push([event, detail]);
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        isrSet,
        revalidateSeconds: 60,
        linkHeader: null,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    await expect(response.text()).resolves.toBe("<h1>personalized</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["HTML cache write skipped (dynamic usage during render)", "html:/dynamic-html-cleanup"],
    ]);
  });

  it("schedules RSC cache writes when the page stayed static through stream consumption", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
      expireSeconds: number | undefined;
      revalidateSeconds: number | false;
      tags: string[];
    }> = [];

    const didSchedule = scheduleAppPageRscCacheWrite({
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/fresh-rsc",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/fresh-rsc", "_N_T_/fresh-rsc"];
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet(key, data, policy) {
        isrSetCalls.push({
          key,
          html: data.html,
          hasRscData: Boolean(data.rscData),
          expireSeconds: policy.cacheControl.expire,
          revalidateSeconds: policy.cacheControl.revalidate,
          tags: policy.tags ?? [],
        });
      },
      expireSeconds: 300,
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual([
      {
        key: "rsc:/fresh-rsc",
        html: "",
        hasRscData: true,
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh-rsc", "_N_T_/fresh-rsc"],
      },
    ]);
    expect(debugCalls).toEqual([["RSC cache written", "rsc:/fresh-rsc"]]);
  });

  it.each(["createHtmlRenderObservation", "createRscRenderObservation"] as const)(
    "skips HTML and RSC cache writes, keeping headers, when %s may have read searchParams",
    async (unprovenBuilder) => {
      const pendingCacheWrites: Promise<void>[] = [];
      const debugCalls: Array<[string, string]> = [];
      const isrSet = vi.fn<AppPageCacheSetter>(async () => {});
      const finalize = (builders: typeof queryInvariantObservationBuilders) =>
        finalizeAppPageHtmlCacheResponse(
          new Response("<h1>fresh</h1>", {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "s-maxage=60, stale-while-revalidate",
              "X-Vinext-Cache": "MISS",
            },
          }),
          {
            ...builders,
            isStaticEligible: true,
            capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
            cleanPathname: "/fresh",
            consumeDynamicUsage() {
              return false;
            },
            getPageTags() {
              return ["/fresh"];
            },
            isrDebug(event, detail) {
              debugCalls.push([event, detail]);
            },
            isrHtmlKey(pathname) {
              return "html:" + pathname;
            },
            isrRscKey(pathname) {
              return "rsc:" + pathname;
            },
            isrSet,
            revalidateSeconds: 60,
            linkHeader: null,
            waitUntil(promise) {
              pendingCacheWrites.push(promise);
            },
          },
        );

      const proven = finalize(queryInvariantObservationBuilders);
      const response = finalize({
        ...queryInvariantObservationBuilders,
        [unprovenBuilder]: buildSearchParamsReadRenderObservation,
      });

      expect([...response.headers]).toEqual([...proven.headers]);
      await expect(response.text()).resolves.toBe("<h1>fresh</h1>");
      await proven.text();
      await Promise.all(pendingCacheWrites);
      expect(isrSet.mock.calls.map(([key]) => key)).toEqual(["html:/fresh", "rsc:/fresh"]);
      expect(debugCalls).toContainEqual([
        "HTML cache write skipped (searchParams not proven unread)",
        "html:/fresh",
      ]);
    },
  );

  it("skips RSC cache writes when the render may have read searchParams", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSet = vi.fn(async () => {});

    const didSchedule = scheduleAppPageRscCacheWrite({
      createRscRenderObservation: buildSearchParamsReadRenderObservation,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/fresh-rsc",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/fresh-rsc"];
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    await Promise.all(pendingCacheWrites);
    expect(isrSet).not.toHaveBeenCalled();
  });

  it("skips persistent RSC cache writes for mounted-slot variants", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrRscKey = vi.fn();
    const isrSet = vi.fn();

    const didSchedule = scheduleAppPageRscCacheWrite({
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/fresh-rsc",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/fresh-rsc", "_N_T_/fresh-rsc"];
      },
      isrRscKey,
      isrSet,
      mountedSlotsHeader: "slot:auth:/",
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(false);
    expect(pendingCacheWrites).toEqual([]);
    expect(isrRscKey).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
  });

  it("marks mounted-slot RSC cache MISS responses no-store without persisting them", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrRscKey = vi.fn();
    const isrSet = vi.fn();

    const response = finalizeAppPageRscCacheResponse(
      new Response("flight", {
        headers: {
          "Content-Type": "text/x-component",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "X-Example-Edge-Policy": "public, max-age=60",
          "X-Example-Cache-Tag": "/fresh-rsc",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/fresh-rsc",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/fresh-rsc"];
        },
        isrRscKey,
        isrSet,
        mountedSlotsHeader: "slot:auth:/",
        preserveClientResponseHeaders: false,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    // The slot variant is never written to the ISR store, but the fresh MISS
    // still has to leave the origin uncacheable by shared caches.
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Example-Edge-Policy")).toBe("public, max-age=60");
    expect(response.headers.get("X-Example-Cache-Tag")).toBe("/fresh-rsc");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("flight");
    expect(pendingCacheWrites).toEqual([]);
    expect(isrRscKey).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
  });

  it("preserves adapter-unowned headers on mounted dynamic RSC responses", async () => {
    const response = finalizeAppPageRscCacheResponse(
      new Response("dynamic flight", {
        headers: {
          "Cache-Control": "no-store, must-revalidate",
          "X-Example-Edge-Policy": "public, max-age=60",
          "X-Example-Cache-Tag": "/dynamic-rsc",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: null,
        cleanPathname: "/dynamic-rsc",
        consumeDynamicUsage() {
          return true;
        },
        dynamicUsedDuringBuild: true,
        getPageTags() {
          return ["/dynamic-rsc"];
        },
        isrRscKey: vi.fn(),
        isrSet: vi.fn(),
        mountedSlotsHeader: "slot:auth:/",
        preserveClientResponseHeaders: true,
        revalidateSeconds: null,
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Example-Edge-Policy")).toBe("public, max-age=60");
    expect(response.headers.get("X-Example-Cache-Tag")).toBe("/dynamic-rsc");
    expect(response.headers.get("X-Vinext-Cache")).toBeNull();
    expect(response.headers.get("X-Nextjs-Cache")).toBeNull();
    await expect(response.text()).resolves.toBe("dynamic flight");
  });

  it("marks client-facing RSC cache MISS responses no-store until the stream dynamic check finishes", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: string[] = [];

    const response = finalizeAppPageRscCacheResponse(
      new Response("flight", {
        headers: {
          "Content-Type": "text/x-component",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "X-Example-Edge-Policy": "public, max-age=60",
          "X-Example-Cache-Tag": "/fresh-rsc",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/fresh-rsc",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/fresh-rsc"];
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key) {
          isrSetCalls.push(key);
        },
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Example-Edge-Policy")).toBe("public, max-age=60");
    expect(response.headers.get("X-Example-Cache-Tag")).toBe("/fresh-rsc");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("flight");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual(["rsc:/fresh-rsc"]);
  });

  it("omits provisional RSC cache state when pending dynamic usage may depend on query params", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: string[] = [];

    const response = finalizeAppPageRscCacheResponse(
      new Response("flight", {
        headers: {
          "Content-Type": "text/x-component",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        ...queryInvariantObservationBuilders,
        isStaticEligible: true,
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/fresh-rsc",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/fresh-rsc"];
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key) {
          isrSetCalls.push(key);
        },
        omitPendingDynamicCacheState: true,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Vinext-Cache")).toBeNull();
    expect(response.headers.get("X-Nextjs-Cache")).toBeNull();
    await expect(response.text()).resolves.toBe("flight");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual(["rsc:/fresh-rsc"]);
  });

  it("skips RSC cache writes when dynamic usage appears during stream rendering", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const didSchedule = scheduleAppPageRscCacheWrite({
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/dynamic-rsc",
      consumeDynamicUsage() {
        return true;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/dynamic-rsc", "_N_T_/dynamic-rsc"];
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["RSC cache write skipped (dynamic usage during render)", "rsc:/dynamic-rsc"],
    ]);
  });

  it("skips cache writes when request cacheLife resolves to a non-finite revalidate", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const didSchedule = scheduleAppPageRscCacheWrite({
      ...queryInvariantObservationBuilders,
      isStaticEligible: true,
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/invalid-cache-life",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/invalid-cache-life"];
      },
      getRequestCacheLife() {
        return { revalidate: Number.NaN };
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: null,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["RSC cache write skipped (no cache policy)", "rsc:/invalid-cache-life"],
    ]);
  });
});

describe("app page regeneration failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    setCacheHandler(new MemoryCacheHandler());
  });

  const staleObservation: RenderObservation = {
    ...buildQueryInvariantRenderObservation(),
    cacheTags: ["_N_T_/stale", "posts"],
  };

  function readStale(options: {
    isRscRequest?: boolean;
    isrGet: (key: string) => Promise<ISRCacheEntry | null>;
    isrSet: AppPageCacheSetter;
    renderFreshPageForCache: () => Promise<ReturnType<typeof freshPage>>;
    scheduled: Array<() => Promise<void>>;
  }) {
    return readAppPageCacheResponse({
      cleanPathname: "/stale",
      clearRequestContext() {},
      isRscRequest: options.isRscRequest ?? false,
      isrGet: options.isrGet,
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet: options.isrSet,
      revalidateSeconds: 60,
      renderFreshPageForCache: options.renderFreshPageForCache,
      scheduleBackgroundRegeneration(_key, renderFn) {
        options.scheduled.push(renderFn);
      },
    });
  }

  function freshPage(overrides: { usedDynamicApi: boolean }) {
    return {
      ...queryInvariantRegenObservations(),
      html: "<h1>fresh</h1>",
      rscData: new TextEncoder().encode("fresh-flight").buffer,
      tags: ["_N_T_/stale"],
      ...overrides,
    };
  }

  it.each([
    { failure: "throws", isRscRequest: false },
    { failure: "throws", isRscRequest: true },
    { failure: "turns dynamic", isRscRequest: false },
    { failure: "turns dynamic", isRscRequest: true },
  ] as const)(
    "serves stale and re-stores only its own key when a regeneration $failure (RSC request: $isRscRequest)",
    async ({ failure, isRscRequest }) => {
      const cachedValue = buildCachedAppPageValue(
        isRscRequest ? "" : "<h1>stale</h1>",
        isRscRequest ? new TextEncoder().encode("stale-flight").buffer : undefined,
        200,
        staleObservation,
      );
      const scheduled: Array<() => Promise<void>> = [];
      const isrSet = vi.fn<AppPageCacheSetter>(async () => {});

      const response = await readStale({
        isRscRequest,
        async isrGet() {
          return buildISRCacheEntry(cachedValue, true, { revalidate: 60, expire: 300, stale: 30 });
        },
        isrSet,
        async renderFreshPageForCache() {
          if (failure === "throws") throw new Error("regeneration failed");
          return freshPage({ usedDynamicApi: true });
        },
        scheduled,
      });

      expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
      await expect(scheduled[0]()).rejects.toThrow(
        failure === "throws"
          ? "regeneration failed"
          : "Page changed from static to dynamic at runtime /stale",
      );
      expect(isrSet).toHaveBeenCalledOnce();
      const [key, data, policy] = isrSet.mock.calls[0];
      expect(key).toBe(isRscRequest ? "rsc:/stale" : "html:/stale");
      expect(data).toBe(cachedValue);
      expect(policy).toEqual({
        cacheControl: { revalidate: 30, expire: 300, stale: 30 },
        tags: ["_N_T_/stale", "posts"],
      });
    },
  );

  it("keeps the previous entry when storing the regenerated page fails", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation);
    const scheduled: Array<() => Promise<void>> = [];
    const isrSet = vi.fn<AppPageCacheSetter>(async (key, data) => {
      if (data !== cachedValue && key === "html:/stale") throw new Error("store failed");
    });

    await readStale({
      async isrGet() {
        return buildISRCacheEntry(cachedValue, true, { revalidate: 60 });
      },
      isrSet,
      async renderFreshPageForCache() {
        return freshPage({ usedDynamicApi: false });
      },
      scheduled,
    });

    await expect(scheduled[0]()).rejects.toThrow("store failed");
    const restored = isrSet.mock.calls.filter(([, data]) => data === cachedValue);
    expect(restored).toEqual([
      [
        "html:/stale",
        cachedValue,
        { cacheControl: { revalidate: 30 }, tags: ["_N_T_/stale", "posts"] },
      ],
    ]);
  });

  it("re-stores the previous entry only after a slower sibling write settles", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation);
    const scheduled: Array<() => Promise<void>> = [];
    const writes: string[] = [];
    const isrSet = vi.fn<AppPageCacheSetter>(async (key, data) => {
      if (data === cachedValue) {
        writes.push("restore " + key);
        return;
      }
      if (key === "rsc:/stale") throw new Error("rsc store failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push("fresh " + key);
    });

    await readStale({
      async isrGet() {
        return buildISRCacheEntry(cachedValue, true, { revalidate: 60 });
      },
      isrSet,
      async renderFreshPageForCache() {
        return freshPage({ usedDynamicApi: false });
      },
      scheduled,
    });

    await expect(scheduled[0]()).rejects.toThrow("rsc store failed");
    expect(writes).toEqual(["fresh html:/stale", "restore html:/stale"]);
  });

  it.each([
    { previous: { revalidate: 1 }, restored: { revalidate: 3 } },
    { previous: { revalidate: 10, expire: 12 }, restored: { revalidate: 10, expire: 13 } },
    { previous: { revalidate: 600, expire: 3600 }, restored: { revalidate: 30, expire: 3600 } },
    { previous: { revalidate: Infinity }, restored: { revalidate: 3 } },
    { previous: { revalidate: false }, restored: { revalidate: 3 } },
  ] satisfies Array<{ previous: CacheControlMetadata; restored: CacheControlMetadata }>)(
    "clamps a failed regeneration's re-stored policy from $previous.revalidate s",
    async ({ previous, restored }) => {
      const scheduled: Array<() => Promise<void>> = [];
      const isrSet = vi.fn<AppPageCacheSetter>(async () => {});

      await readStale({
        async isrGet() {
          return buildISRCacheEntry(
            buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation),
            true,
            previous,
          );
        },
        isrSet,
        async renderFreshPageForCache() {
          throw new Error("regeneration failed");
        },
        scheduled,
      });

      await expect(scheduled[0]()).rejects.toThrow("regeneration failed");
      expect(isrSet.mock.calls[0][2]).toEqual({
        cacheControl: restored,
        tags: ["_N_T_/stale", "posts"],
      });
    },
  );

  it.each([
    {
      entry: "no stored policy",
      build: () =>
        buildISRCacheEntry(
          buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation),
          true,
        ),
    },
    {
      // Its tags can't be recovered, so re-storing it would drop them.
      entry: "no render observation",
      build: () =>
        buildISRCacheEntry(buildCachedAppPageValue("<h1>stale</h1>"), true, { revalidate: 60 }),
    },
  ])("leaves an entry with $entry alone when its regeneration fails", async ({ build }) => {
    const scheduled: Array<() => Promise<void>> = [];
    const isrSet = vi.fn<AppPageCacheSetter>(async () => {});

    await readStale({
      async isrGet() {
        return build();
      },
      isrSet,
      async renderFreshPageForCache() {
        throw new Error("regeneration failed");
      },
      scheduled,
    });

    await expect(scheduled[0]()).rejects.toThrow("regeneration failed");
    expect(isrSet).not.toHaveBeenCalled();
  });

  it("keeps the regeneration's own error when re-storing the previous entry fails", async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await readStale({
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation),
          true,
          { revalidate: 60 },
        );
      },
      async isrSet() {
        throw new Error("store unavailable");
      },
      async renderFreshPageForCache() {
        throw new Error("regeneration failed");
      },
      scheduled,
    });

    await expect(scheduled[0]()).rejects.toThrow("regeneration failed");
    expect(consoleError).toHaveBeenCalledWith(
      "[vinext] Failed to keep the previous entry for html:/stale:",
      expect.objectContaining({ message: "store unavailable" }),
    );
    consoleError.mockRestore();
  });

  it("doesn't retry a throwing regeneration until the re-stored revalidate elapses", async () => {
    setCacheHandler(new MemoryCacheHandler());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const scheduled: Array<() => Promise<void>> = [];
    const renderFreshPageForCache = async (): Promise<ReturnType<typeof freshPage>> => {
      throw new Error("regeneration failed");
    };

    await readStale({
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation),
          true,
          { revalidate: 10 },
        );
      },
      isrSet,
      renderFreshPageForCache,
      scheduled,
    });
    await expect(scheduled[0]()).rejects.toThrow("regeneration failed");

    vi.setSystemTime(10_500);
    const beforeRetry = await readStale({ isrGet, isrSet, renderFreshPageForCache, scheduled });
    expect(beforeRetry?.headers.get("x-vinext-cache")).toBe("HIT");
    expect(scheduled).toHaveLength(1);

    vi.setSystemTime(11_500);
    const afterRetry = await readStale({ isrGet, isrSet, renderFreshPageForCache, scheduled });
    expect(afterRetry?.headers.get("x-vinext-cache")).toBe("STALE");
    expect(scheduled).toHaveLength(2);
  });

  it("doesn't retry a failed regeneration of a revalidate = false entry for 3 s", async () => {
    setCacheHandler(new MemoryCacheHandler());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const cachedValue = buildCachedAppPageValue("<h1>stale</h1>", undefined, 200, staleObservation);
    const scheduled: Array<() => Promise<void>> = [];
    const renderFreshPageForCache = async () => freshPage({ usedDynamicApi: true });

    // The first read finds the entry stale, as after an on-demand revalidation.
    await readStale({
      async isrGet() {
        return buildISRCacheEntry(cachedValue, true, { revalidate: false });
      },
      isrSet,
      renderFreshPageForCache,
      scheduled,
    });
    await expect(scheduled[0]()).rejects.toThrow("Page changed from static to dynamic");

    vi.setSystemTime(3_500);
    const beforeRetry = await readStale({ isrGet, isrSet, renderFreshPageForCache, scheduled });
    expect(beforeRetry?.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(beforeRetry?.text()).resolves.toBe("<h1>stale</h1>");
    expect(scheduled).toHaveLength(1);

    vi.setSystemTime(4_500);
    const afterRetry = await readStale({ isrGet, isrSet, renderFreshPageForCache, scheduled });
    expect(afterRetry?.headers.get("x-vinext-cache")).toBe("STALE");
    expect(scheduled).toHaveLength(2);
  });
});
