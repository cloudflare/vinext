import { describe, expect, it } from "vite-plus/test";
import {
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
} from "../packages/vinext/src/server/cache-control.js";

describe("cache-control helpers", () => {
  it("uses Next.js expire minus revalidate for finite SWR windows", () => {
    expect(buildRevalidateCacheControl(60, 300)).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("omits stale-while-revalidate when expire does not exceed revalidate", () => {
    expect(buildRevalidateCacheControl(300, 300)).toBe("s-maxage=300");
  });

  it("preserves vinext's legacy unbounded SWR header when expire is unknown", () => {
    expect(buildRevalidateCacheControl(60)).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("uses route policy for STALE cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60, 300)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("uses route policy for HIT cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("HIT", 60, 300)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("preserves legacy STALE cached response headers when expire is unknown", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60)).toBe(
      "s-maxage=0, stale-while-revalidate",
    );
  });

  it("keeps the full expire window when revalidate is zero", () => {
    expect(buildRevalidateCacheControl(0, 300)).toBe("s-maxage=0, stale-while-revalidate=300");
  });
});
