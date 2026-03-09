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
import { describe, it, expect, vi } from "vitest";
import {
  isrCacheKey,
  buildPagesCacheValue,
  buildAppPageCacheValue,
  setRevalidateDuration,
  getRevalidateDuration,
  triggerBackgroundRegeneration,
} from "../packages/vinext/src/server/isr-cache.js";

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
});
