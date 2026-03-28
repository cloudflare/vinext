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
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import {
  isrCacheKey,
  buildPagesCacheValue,
  buildAppPageCacheValue,
  setRevalidateDuration,
  getRevalidateDuration,
  triggerBackgroundRegeneration,
} from "../packages/vinext/src/server/isr-cache.js";
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

  /**
   * Mirrors `__pageCacheTags` in app-rsc-entry.ts — keep in sync.
   */
  function deriveImplicitTags(pathname: string): string[] {
    const tags = ["_N_T_/layout"];
    const segments = pathname.split("/");
    let built = "";
    for (let i = 1; i < segments.length; i++) {
      if (segments[i]) {
        built += "/" + segments[i];
        tags.push(`_N_T_${built}/layout`);
      }
    }
    tags.push(`_N_T_${built}/page`);
    return tags;
  }

  /** Helper: store a FETCH cache entry with path + implicit hierarchy tags. */
  async function seedEntry(path: string, body: string): Promise<void> {
    const tags = [path, `_N_T_${path}`, ...deriveImplicitTags(path)];
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
