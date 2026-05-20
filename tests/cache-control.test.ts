import { describe, expect, it } from "vite-plus/test";
import {
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
  DEPLOY_CACHE_CONTROL,
} from "../packages/vinext/src/server/cache-control.js";

describe("cache-control helpers", () => {
  it("uses Next.js expire minus revalidate for finite SWR windows", () => {
    expect(buildRevalidateCacheControl(60, 300, false)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("omits stale-while-revalidate when expire does not exceed revalidate", () => {
    expect(buildRevalidateCacheControl(300, 300, false)).toBe("s-maxage=300");
  });

  it("preserves vinext's legacy unbounded SWR header when expire is unknown", () => {
    expect(buildRevalidateCacheControl(60, undefined, false)).toBe(
      "s-maxage=60, stale-while-revalidate",
    );
  });

  it("uses route policy for STALE cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60, 300, false)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("uses route policy for HIT cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("HIT", 60, 300, false)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("uses static cache-control for cached indefinite responses", () => {
    expect(buildCachedRevalidateCacheControl("HIT", Infinity, undefined, false)).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
  });

  it("preserves legacy STALE cached response headers when expire is unknown", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60, undefined, false)).toBe(
      "s-maxage=0, stale-while-revalidate",
    );
  });

  it("keeps the full expire window when revalidate is zero", () => {
    expect(buildRevalidateCacheControl(0, 300, false)).toBe(
      "s-maxage=0, stale-while-revalidate=300",
    );
  });

  // ─── Deploy mode (Cloudflare Workers) ────────────────────────────────────
  // Next.js' deploy adapters collapse cacheable HTTP cache-control headers
  // to `public, max-age=0, must-revalidate`. The browser revalidates on
  // every request and the edge/Worker cache layer governs freshness via
  // cache tags. vinext's Next.js compat suite (NEXT_TEST_MODE=deploy)
  // asserts this header for ISR pages, fallback ISR re-renders, and the
  // "no-revalidate static" branch.
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts

  describe("deploy mode", () => {
    it("emits the deploy header instead of s-maxage/SWR for a fresh ISR render", () => {
      expect(buildRevalidateCacheControl(2, 31536000, true)).toBe(DEPLOY_CACHE_CONTROL);
    });

    it("emits the deploy header for ISR pages without an expire ceiling", () => {
      expect(buildRevalidateCacheControl(60, undefined, true)).toBe(DEPLOY_CACHE_CONTROL);
    });

    it("emits the deploy header for HIT cached ISR responses", () => {
      expect(buildCachedRevalidateCacheControl("HIT", 2, 31536000, true)).toBe(
        DEPLOY_CACHE_CONTROL,
      );
    });

    it("emits the deploy header for STALE cached ISR responses", () => {
      expect(buildCachedRevalidateCacheControl("STALE", 2, 31536000, true)).toBe(
        DEPLOY_CACHE_CONTROL,
      );
    });

    it("emits the deploy header for indefinite (revalidate === Infinity) responses", () => {
      expect(buildCachedRevalidateCacheControl("HIT", Infinity, undefined, true)).toBe(
        DEPLOY_CACHE_CONTROL,
      );
    });

    it("emits the deploy header for STALE entries with no expire metadata", () => {
      // Standalone falls back to `s-maxage=0, stale-while-revalidate`. Deploy
      // mode must not leak that fallback because the edge layer handles
      // staleness via cache tags.
      expect(buildCachedRevalidateCacheControl("STALE", 60, undefined, true)).toBe(
        DEPLOY_CACHE_CONTROL,
      );
    });
  });
});
