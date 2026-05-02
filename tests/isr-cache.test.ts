/**
 * ISR cache unit tests.
 *
 * Tests cache key generation, normalization, hash truncation,
 * revalidate duration tracking with LRU eviction, background
 * regeneration deduplication, and cache value builders.
 *
 * These complement the integration-level ISR tests in features.test.ts
 * by testing the ISR cache layer in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import {
  isrCacheKey,
  appIsrHtmlKey,
  appIsrRscKey,
  appIsrRouteKey,
  isrGet,
  isrSet,
  buildPagesCacheValue,
  buildAppPageCacheValue,
  normalizeMountedSlotsHeader,
  setRevalidateDuration,
  getRevalidateDuration,
  triggerBackgroundRegeneration,
} from "../packages/vinext/src/server/isr-cache.js";
import { buildPageCacheTags } from "../packages/vinext/src/server/implicit-tags.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  createRequestContext,
  getRequestContext,
  isInsideUnifiedScope,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  MemoryCacheHandler,
  setCacheHandler,
  revalidatePath,
  type CachedFetchValue,
} from "../packages/vinext/src/shims/cache.js";

// ─── isrCacheKey ────────────────────────────────────────────────────────

describe("isrCacheKey", () => {
  it("generates pages: prefix for Pages Router", () => {
    expect(isrCacheKey("pages", "/about")).toBe("pages:/about");
  });

  it("generates app: prefix for App Router", () => {
    expect(isrCacheKey("app", "/dashboard")).toBe("app:/dashboard");
  });

  it("preserves root / without stripping", () => {
    expect(isrCacheKey("pages", "/")).toBe("pages:/");
  });

  it("strips trailing slash from non-root paths", () => {
    expect(isrCacheKey("pages", "/about/")).toBe("pages:/about");
  });

  it("does not strip trailing slash from root", () => {
    expect(isrCacheKey("pages", "/")).toBe("pages:/");
  });

  it("handles deeply nested paths", () => {
    expect(isrCacheKey("app", "/blog/2024/01/my-post")).toBe("app:/blog/2024/01/my-post");
  });

  it("hashes very long paths (> 200 chars)", () => {
    const longPath = "/" + "a".repeat(250);
    const key = isrCacheKey("pages", longPath);
    expect(key).toMatch(/^pages:__hash:/);
    // Hash should be deterministic
    const key2 = isrCacheKey("pages", longPath);
    expect(key).toBe(key2);
  });

  it("does not hash paths that produce keys <= 200 chars", () => {
    const shortPath = "/about";
    const key = isrCacheKey("pages", shortPath);
    expect(key).toBe("pages:/about");
    expect(key).not.toContain("__hash:");
  });

  it("different long paths produce different hashes", () => {
    const path1 = "/" + "a".repeat(250);
    const path2 = "/" + "b".repeat(250);
    expect(isrCacheKey("pages", path1)).not.toBe(isrCacheKey("pages", path2));
  });

  it("includes buildId in key when provided", () => {
    expect(isrCacheKey("pages", "/about", "abc123")).toBe("pages:abc123:/about");
  });

  it("includes buildId in app router key", () => {
    expect(isrCacheKey("app", "/dashboard", "build-42")).toBe("app:build-42:/dashboard");
  });

  it("preserves root with buildId", () => {
    expect(isrCacheKey("pages", "/", "v1")).toBe("pages:v1:/");
  });

  it("strips trailing slash with buildId", () => {
    expect(isrCacheKey("pages", "/about/", "v1")).toBe("pages:v1:/about");
  });

  it("hashes long paths with buildId", () => {
    const longPath = "/" + "a".repeat(250);
    const key = isrCacheKey("pages", longPath, "build-99");
    expect(key).toMatch(/^pages:build-99:__hash:/);
  });

  it("without buildId format is unchanged (backward compat)", () => {
    expect(isrCacheKey("pages", "/about")).toBe("pages:/about");
    expect(isrCacheKey("app", "/dashboard")).toBe("app:/dashboard");
  });
});

describe("App Router ISR cache key primitives", () => {
  const originalBuildId = process.env.__VINEXT_BUILD_ID;

  afterEach(() => {
    if (originalBuildId === undefined) {
      delete process.env.__VINEXT_BUILD_ID;
      return;
    }

    process.env.__VINEXT_BUILD_ID = originalBuildId;
  });

  it("builds separate html, rsc, and route keys from the normalized pathname", () => {
    delete process.env.__VINEXT_BUILD_ID;

    expect(appIsrHtmlKey("/about/")).toBe("app:/about:html");
    expect(appIsrRscKey("/about/")).toBe("app:/about:rsc");
    expect(appIsrRouteKey("/api/feed/")).toBe("app:/api/feed:route");
  });

  it("includes the build id when present", () => {
    process.env.__VINEXT_BUILD_ID = "build-42";

    expect(appIsrHtmlKey("/dashboard")).toBe("app:build-42:/dashboard:html");
  });

  it("hashes long pathname keys while preserving the cache entry suffix", () => {
    delete process.env.__VINEXT_BUILD_ID;

    const key = appIsrRscKey("/" + "a".repeat(250));

    expect(key).toMatch(/^app:__hash:[a-z0-9]+:rsc$/);
  });

  it("keys mounted-slot RSC variants by normalized mounted-slot header", () => {
    delete process.env.__VINEXT_BUILD_ID;

    const first = appIsrRscKey("/feed", "modal sidebar");
    const second = appIsrRscKey("/feed", "sidebar modal");

    expect(first).toBe(second);
    expect(first).toMatch(/^app:\/feed:rsc:[a-z0-9]+$/);
  });
});

describe("normalizeMountedSlotsHeader", () => {
  it("returns null for missing or blank mounted-slot headers", () => {
    expect(normalizeMountedSlotsHeader(null)).toBeNull();
    expect(normalizeMountedSlotsHeader("   \t\n  ")).toBeNull();
  });

  it("deduplicates and sorts whitespace-separated slot ids", () => {
    expect(normalizeMountedSlotsHeader(" sidebar  modal sidebar\tcart ")).toBe(
      "cart modal sidebar",
    );
  });
});

// ─── buildPagesCacheValue ───────────────────────────────────────────────

describe("buildPagesCacheValue", () => {
  it("builds correct structure", () => {
    const value = buildPagesCacheValue("<html>test</html>", { title: "Test" });
    expect(value.kind).toBe("PAGES");
    expect(value.html).toBe("<html>test</html>");
    expect(value.pageData).toEqual({ title: "Test" });
    expect(value.headers).toBeUndefined();
    expect(value.status).toBeUndefined();
  });

  it("includes status when provided", () => {
    const value = buildPagesCacheValue("<html>404</html>", {}, 404);
    expect(value.status).toBe(404);
  });
});

// ─── buildAppPageCacheValue ─────────────────────────────────────────────

describe("buildAppPageCacheValue", () => {
  it("builds correct structure", () => {
    const value = buildAppPageCacheValue("<html>app</html>");
    expect(value.kind).toBe("APP_PAGE");
    expect(value.html).toBe("<html>app</html>");
    expect(value.rscData).toBeUndefined();
    expect(value.headers).toBeUndefined();
    expect(value.postponed).toBeUndefined();
    expect(value.status).toBeUndefined();
  });

  it("includes rscData when provided", () => {
    const rscData = new ArrayBuffer(8);
    const value = buildAppPageCacheValue("<html>app</html>", rscData);
    expect(value.rscData).toBe(rscData);
  });

  it("includes status when provided", () => {
    const value = buildAppPageCacheValue("<html>app</html>", undefined, 200);
    expect(value.status).toBe(200);
  });
});

// ─── Revalidate duration tracking ───────────────────────────────────────

describe("setRevalidateDuration / getRevalidateDuration", () => {
  it("stores and retrieves a duration", () => {
    setRevalidateDuration("test-key-1", 60);
    expect(getRevalidateDuration("test-key-1")).toBe(60);
  });

  it("returns undefined for unknown keys", () => {
    expect(getRevalidateDuration("nonexistent-key-xyz")).toBeUndefined();
  });

  it("overwrites previous values", () => {
    setRevalidateDuration("test-key-2", 60);
    setRevalidateDuration("test-key-2", 120);
    expect(getRevalidateDuration("test-key-2")).toBe(120);
  });

  it("handles zero duration", () => {
    setRevalidateDuration("test-key-3", 0);
    expect(getRevalidateDuration("test-key-3")).toBe(0);
  });
});

// ─── Expire ceiling handling ────────────────────────────────────────────

describe("ISR expire ceiling", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setCacheHandler(new MemoryCacheHandler());
  });

  it("serves stale within expire and treats entries beyond expire as hard misses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);

    await isrSet("expire-test", buildPagesCacheValue("<html>cached</html>", {}), 1, [], 3);

    vi.setSystemTime(2_500);
    const stale = await isrGet("expire-test");
    expect(stale?.isStale).toBe(true);
    expect(stale?.value.value?.kind).toBe("PAGES");

    vi.setSystemTime(4_500);
    await expect(isrGet("expire-test")).resolves.toBeNull();
  });

  it("preserves legacy revalidate context while writing cache-control metadata", async () => {
    let setContext: Record<string, unknown> | undefined;
    setCacheHandler({
      async get() {
        return null;
      },
      async set(_key, _data, ctx) {
        setContext = ctx;
      },
      async revalidateTag() {},
    });

    await isrSet("compat-test", buildPagesCacheValue("<html>cached</html>", {}), 60, ["tag"], 300);

    expect(setContext).toEqual({
      cacheControl: { revalidate: 60, expire: 300 },
      revalidate: 60,
      tags: ["tag"],
    });
  });

  it("treats cache handlers that report expired entries as hard misses", async () => {
    setCacheHandler({
      async get() {
        return {
          lastModified: Date.now() - 10_000,
          cacheState: "expired",
          value: buildPagesCacheValue("<html>expired</html>", {}),
        };
      },
      async set() {},
      async revalidateTag() {},
    });

    await expect(isrGet("expired-handler-entry")).resolves.toBeNull();
  });
});

// ─── triggerBackgroundRegeneration ───────────────────────────────────────

describe("triggerBackgroundRegeneration", () => {
  it("calls the render function", async () => {
    const renderFn = vi.fn().mockResolvedValue(undefined);
    triggerBackgroundRegeneration("regen-test-1", renderFn);
    // Wait for the async operation
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFn).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent regeneration for same key", async () => {
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const renderFn1 = vi.fn().mockReturnValue(firstPromise);
    const renderFn2 = vi.fn().mockResolvedValue(undefined);

    triggerBackgroundRegeneration("regen-test-2", renderFn1);
    triggerBackgroundRegeneration("regen-test-2", renderFn2);

    // Only the first should have been called
    expect(renderFn1).toHaveBeenCalledOnce();
    expect(renderFn2).not.toHaveBeenCalled();

    // Complete the first
    resolveFirst!();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("allows regeneration after previous completes", async () => {
    const renderFn1 = vi.fn().mockResolvedValue(undefined);
    triggerBackgroundRegeneration("regen-test-3", renderFn1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFn1).toHaveBeenCalledOnce();

    // After completion, a new regeneration should be allowed
    const renderFn2 = vi.fn().mockResolvedValue(undefined);
    triggerBackgroundRegeneration("regen-test-3", renderFn2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFn2).toHaveBeenCalledOnce();
  });

  it("handles render function errors gracefully", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const renderFn = vi.fn().mockRejectedValue(new Error("render failed"));

    triggerBackgroundRegeneration("regen-test-4", renderFn);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(renderFn).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();

    // After error, key should be cleared so new regeneration is possible
    const renderFn2 = vi.fn().mockResolvedValue(undefined);
    triggerBackgroundRegeneration("regen-test-4", renderFn2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFn2).toHaveBeenCalledOnce();

    consoleError.mockRestore();
  });

  it("reports error via onRequestError handler when errorContext is provided", async () => {
    const handler = vi.fn();
    globalThis.__VINEXT_onRequestErrorHandler__ = handler;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const renderFn = vi.fn().mockRejectedValue(new Error("regen failed"));
      triggerBackgroundRegeneration("regen-report-error", renderFn, {
        routerKind: "App Router",
        routePath: "/blog/[slug]",
        routeType: "render",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledOnce();
      const [error, request, context] = handler.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("regen failed");
      expect(request).toEqual({ path: "regen-report-error", method: "GET", headers: {} });
      expect(context).toEqual({
        routerKind: "App Router",
        routePath: "/blog/[slug]",
        routeType: "render",
        revalidateReason: "stale",
      });
    } finally {
      delete globalThis.__VINEXT_onRequestErrorHandler__;
      consoleError.mockRestore();
    }
  });

  it("does NOT call onRequestError handler when errorContext is omitted", async () => {
    const handler = vi.fn();
    globalThis.__VINEXT_onRequestErrorHandler__ = handler;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const renderFn = vi.fn().mockRejectedValue(new Error("regen failed"));
      triggerBackgroundRegeneration("regen-no-ctx", renderFn);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleError).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      delete globalThis.__VINEXT_onRequestErrorHandler__;
      consoleError.mockRestore();
    }
  });

  it("wraps non-Error throw values in Error before reporting", async () => {
    const handler = vi.fn();
    globalThis.__VINEXT_onRequestErrorHandler__ = handler;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const renderFn = vi.fn().mockRejectedValue("string error");
      triggerBackgroundRegeneration("regen-string-error", renderFn, {
        routerKind: "Pages Router",
        routePath: "/about",
        routeType: "render",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledOnce();
      const [error] = handler.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("string error");
    } finally {
      delete globalThis.__VINEXT_onRequestErrorHandler__;
      consoleError.mockRestore();
    }
  });

  it("different keys run independently", async () => {
    const renderFnA = vi.fn().mockResolvedValue(undefined);
    const renderFnB = vi.fn().mockResolvedValue(undefined);

    triggerBackgroundRegeneration("regen-test-5a", renderFnA);
    triggerBackgroundRegeneration("regen-test-5b", renderFnB);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFnA).toHaveBeenCalledOnce();
    expect(renderFnB).toHaveBeenCalledOnce();
  });

  it("calls ctx.waitUntil with the regen promise when ctx is in ALS", async () => {
    const waitUntil = vi.fn();
    const ctx = { waitUntil };

    let resolveRender: () => void;
    const renderPromise = new Promise<void>((r) => {
      resolveRender = r;
    });
    const renderFn = vi.fn().mockReturnValue(renderPromise);

    await runWithExecutionContext(ctx, async () => {
      triggerBackgroundRegeneration("regen-ctx-1", renderFn);
    });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));

    resolveRender!();
    await renderPromise;
  });

  it("preserves unified request context for async work started by regeneration", async () => {
    let releaseRender!: () => void;
    const resumeRender = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });

    let regenPromise: Promise<unknown> | null = null;
    const executionContext = {
      waitUntil(promise: Promise<unknown>) {
        regenPromise = promise;
      },
    };

    let sawUnifiedScope = false;
    let collectedTags: string[] = [];

    await runWithExecutionContext(executionContext, async () => {
      await runWithRequestContext(
        createRequestContext({ currentRequestTags: ["outer-tag"] }),
        async () => {
          triggerBackgroundRegeneration("regen-unified-scope", async () => {
            await resumeRender;
            sawUnifiedScope = isInsideUnifiedScope();
            collectedTags = [...getRequestContext().currentRequestTags];
          });
        },
      );
    });

    expect(isInsideUnifiedScope()).toBe(false);
    if (!regenPromise) {
      throw new Error("expected triggerBackgroundRegeneration to register waitUntil");
    }
    const pendingRegen = regenPromise;

    releaseRender();
    await Promise.resolve(pendingRegen);

    expect(sawUnifiedScope).toBe(true);
    expect(collectedTags).toEqual(["outer-tag"]);
  });

  it("does not require ctx — works without it", async () => {
    const renderFn = vi.fn().mockResolvedValue(undefined);
    // No ctx passed — should not throw
    triggerBackgroundRegeneration("regen-no-ctx", renderFn);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderFn).toHaveBeenCalledOnce();
  });
});

// ─── revalidatePath with type parameter ──────────────────────────────────

describe("revalidatePath type parameter", () => {
  let handler: MemoryCacheHandler;

  function staticRouteSegments(pathname: string): string[] {
    return pathname.split("/").filter(Boolean);
  }

  /** Helper: store a FETCH cache entry with path + implicit hierarchy tags. */
  async function seedEntry(
    path: string,
    body: string,
    routeSegments = staticRouteSegments(path),
  ): Promise<void> {
    const tags = buildPageCacheTags(path, [], routeSegments, "page");
    const value: CachedFetchValue = {
      kind: "FETCH",
      data: { headers: {}, body, url: path },
      tags,
      revalidate: false,
    };
    await handler.set(`entry:${path}`, value, { tags });
  }

  beforeEach(() => {
    handler = new MemoryCacheHandler();
    setCacheHandler(handler);
  });

  it("invalidates the layout path AND all child paths when type is 'layout'", async () => {
    await seedEntry("/dashboard", "dashboard-root");
    await seedEntry("/dashboard/settings", "settings");
    await seedEntry("/dashboard/profile", "profile");
    await seedEntry("/about", "about-page");

    // All four entries should be present before revalidation
    expect(await handler.get("entry:/dashboard")).not.toBeNull();
    expect(await handler.get("entry:/dashboard/settings")).not.toBeNull();
    expect(await handler.get("entry:/dashboard/profile")).not.toBeNull();
    expect(await handler.get("entry:/about")).not.toBeNull();

    await revalidatePath("/dashboard", "layout");

    // All three dashboard entries should be invalidated
    expect(await handler.get("entry:/dashboard")).toBeNull();
    expect(await handler.get("entry:/dashboard/settings")).toBeNull();
    expect(await handler.get("entry:/dashboard/profile")).toBeNull();

    // /about should NOT be invalidated
    expect(await handler.get("entry:/about")).not.toBeNull();
  });

  it("invalidates only the exact path when type is 'page'", async () => {
    await seedEntry("/about", "about-page");
    await seedEntry("/about/team", "about-team");

    await revalidatePath("/about", "page");

    // Only /about should be invalidated
    expect(await handler.get("entry:/about")).toBeNull();
    // /about/team should remain
    expect(await handler.get("entry:/about/team")).not.toBeNull();
  });

  it("invalidates the exact path when no type is specified", async () => {
    await seedEntry("/about", "about-page");
    await seedEntry("/about/team", "about-team");

    await revalidatePath("/about");

    // Only /about should be invalidated
    expect(await handler.get("entry:/about")).toBeNull();
    // /about/team should remain
    expect(await handler.get("entry:/about/team")).not.toBeNull();
  });

  it("uses route pattern tags for typed dynamic route invalidation", async () => {
    await seedEntry("/blog/hello", "hello", ["blog", "[slug]"]);

    await revalidatePath("/blog/hello", "layout");
    expect(await handler.get("entry:/blog/hello")).not.toBeNull();

    await revalidatePath("/blog/[slug]", "layout");
    expect(await handler.get("entry:/blog/hello")).toBeNull();

    await seedEntry("/blog/hello", "hello", ["blog", "[slug]"]);

    await revalidatePath("/blog/hello");
    expect(await handler.get("entry:/blog/hello")).toBeNull();
  });

  it("handles deeply nested children under a layout prefix", async () => {
    await seedEntry("/app", "app-root");
    await seedEntry("/app/blog", "blog");
    await seedEntry("/app/blog/2024", "blog-2024");
    await seedEntry("/app/blog/2024/01/post", "blog-post");

    await revalidatePath("/app", "layout");

    // All entries under /app should be invalidated
    expect(await handler.get("entry:/app")).toBeNull();
    expect(await handler.get("entry:/app/blog")).toBeNull();
    expect(await handler.get("entry:/app/blog/2024")).toBeNull();
    expect(await handler.get("entry:/app/blog/2024/01/post")).toBeNull();
  });

  it("does not invalidate paths that merely share a string prefix", async () => {
    // /dashboard-admin starts with "/dashboard" as a string, but it's NOT
    // a child route of /dashboard — it's a sibling. The prefix match must
    // be path-segment-aware (match "/dashboard/" or exact "/dashboard").
    await seedEntry("/dashboard", "dashboard");
    await seedEntry("/dashboard-admin", "dashboard-admin");
    await seedEntry("/dashboard/settings", "settings");

    await revalidatePath("/dashboard", "layout");

    expect(await handler.get("entry:/dashboard")).toBeNull();
    expect(await handler.get("entry:/dashboard/settings")).toBeNull();
    // /dashboard-admin should NOT be invalidated — different route
    expect(await handler.get("entry:/dashboard-admin")).not.toBeNull();
  });

  it("handles root path '/' with layout type — invalidates everything", async () => {
    await seedEntry("/", "home");
    await seedEntry("/about", "about");
    await seedEntry("/dashboard", "dashboard");
    await seedEntry("/dashboard/settings", "settings");

    await revalidatePath("/", "layout");

    // Root layout covers all routes
    expect(await handler.get("entry:/")).toBeNull();
    expect(await handler.get("entry:/about")).toBeNull();
    expect(await handler.get("entry:/dashboard")).toBeNull();
    expect(await handler.get("entry:/dashboard/settings")).toBeNull();
  });

  it("handles root path '/' with page type — invalidates only the root page", async () => {
    await seedEntry("/", "home");
    await seedEntry("/about", "about");

    await revalidatePath("/", "page");

    // Root page should be invalidated
    expect(await handler.get("entry:/")).toBeNull();
    // Other pages should remain — "page" type targets only the exact route
    expect(await handler.get("entry:/about")).not.toBeNull();
  });

  it("trailing slash on layout path is normalized — same as without trailing slash", async () => {
    await seedEntry("/dashboard", "dashboard-root");
    await seedEntry("/dashboard/settings", "settings");
    await seedEntry("/about", "about-page");

    // revalidatePath("/dashboard/", "layout") must behave like ("/dashboard", "layout")
    await revalidatePath("/dashboard/", "layout");

    expect(await handler.get("entry:/dashboard")).toBeNull();
    expect(await handler.get("entry:/dashboard/settings")).toBeNull();
    // /about should NOT be invalidated
    expect(await handler.get("entry:/about")).not.toBeNull();
  });

  it("type 'page' invalidates via /page tag, not the bare path tag", async () => {
    // Seed two synthetic entries to prove the tag paths are distinct:
    // Entry A: only the /page leaf tag — only revalidatePath(path, "page") should hit it
    // Entry B: only the bare _N_T_ path tag — only revalidatePath(path) should hit it
    const pageOnlyValue: CachedFetchValue = {
      kind: "FETCH",
      data: { headers: {}, body: "page-only", url: "/about" },
      tags: ["_N_T_/about/page"],
      revalidate: false,
    };
    const barePathValue: CachedFetchValue = {
      kind: "FETCH",
      data: { headers: {}, body: "bare-path", url: "/about" },
      tags: ["/about", "_N_T_/about"],
      revalidate: false,
    };
    await handler.set("entry:page-only", pageOnlyValue, { tags: ["_N_T_/about/page"] });
    await handler.set("entry:bare-path", barePathValue, { tags: ["/about", "_N_T_/about"] });

    await revalidatePath("/about", "page");

    // "page" type targets the /page leaf tag only
    expect(await handler.get("entry:page-only")).toBeNull();
    // The bare path entry should NOT be touched
    expect(await handler.get("entry:bare-path")).not.toBeNull();
  });

  it("trailing slash on page path is normalized — same as without trailing slash", async () => {
    await seedEntry("/about", "about-page");
    await seedEntry("/about/team", "about-team");

    // revalidatePath("/about/", "page") must be equivalent to ("/about", "page")
    await revalidatePath("/about/", "page");

    expect(await handler.get("entry:/about")).toBeNull();
    // /about/team should remain — only the exact path was invalidated
    expect(await handler.get("entry:/about/team")).not.toBeNull();
  });
});
