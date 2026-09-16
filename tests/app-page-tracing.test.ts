import { describe, expect, it } from "vite-plus/test";
import { resolveAppPageTraceOperation } from "../packages/vinext/src/server/app-page-tracing.js";

describe("App Page tracing", () => {
  // Next.js treats unknown fallback paths for a successfully prerendered route as SSG.
  // Ported from Next.js: packages/next/src/build/templates/app-page-runtime.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/app-page-runtime.ts
  it("uses prerender for an unknown fallback path on a build-prerendered route", () => {
    expect(
      resolveAppPageTraceOperation({
        hasRequestSearchParams: false,
        isDynamicError: false,
        isForceStatic: false,
        isKnownPrerenderedRoute: true,
        isPrerender: false,
      }),
    ).toBe("prerender");
  });

  it("uses render when a query-bearing request cannot reuse the static route response", () => {
    expect(
      resolveAppPageTraceOperation({
        hasRequestSearchParams: true,
        isDynamicError: false,
        isForceStatic: false,
        isKnownPrerenderedRoute: true,
        isPrerender: false,
      }),
    ).toBe("render");
  });

  it.each([
    { isDynamicError: false, isForceStatic: false, isPrerender: true },
    { isDynamicError: false, isForceStatic: true, isPrerender: false },
    { isDynamicError: true, isForceStatic: false, isPrerender: false },
  ])("uses prerender for an explicit static execution", (staticState) => {
    expect(
      resolveAppPageTraceOperation({
        hasRequestSearchParams: true,
        isKnownPrerenderedRoute: false,
        ...staticState,
      }),
    ).toBe("prerender");
  });

  it("uses render when no pre-render fact establishes static execution", () => {
    expect(
      resolveAppPageTraceOperation({
        hasRequestSearchParams: false,
        isDynamicError: false,
        isForceStatic: false,
        isKnownPrerenderedRoute: false,
        isPrerender: false,
      }),
    ).toBe("render");
  });
});
