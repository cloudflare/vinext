import { describe, expect, it } from "vite-plus/test";
import {
  createComponentTreeSpanDescriptor,
  createGetLayoutOrPageModuleSpanDescriptor,
  resolveAppPageModuleTraceSegment,
  resolveAppPageTraceOperation,
} from "../packages/vinext/src/server/app-page-tracing.js";

describe("App Page tracing", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  it("matches the stable Next.js segment module span descriptor", () => {
    expect(createGetLayoutOrPageModuleSpanDescriptor("__PAGE__")).toEqual({
      attributes: { "next.segment": "__PAGE__" },
      name: "resolve segment modules",
      type: "NextNodeServer.getLayoutOrPageModule",
    });
  });

  it("matches the stable Next.js component tree span descriptor", () => {
    expect(createComponentTreeSpanDescriptor()).toEqual({
      name: "build component tree",
      type: "NextNodeServer.createComponentTree",
    });
  });

  it.each([
    { expected: "", position: 0, segments: ["app", "[param]"] },
    { expected: "app", position: 1, segments: ["app", "[param]"] },
    { expected: "[param]", position: 2, segments: ["app", "[param]"] },
  ])(
    "resolves the module segment at tree position $position",
    ({ expected, position, segments }) => {
      expect(resolveAppPageModuleTraceSegment(segments, position)).toBe(expected);
    },
  );

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
