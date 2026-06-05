import { describe, expect, it } from "vitest";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

describe("RSC Flight hint fix", () => {
  it("generateRscEntry delegates renderToReadableStream hint normalization", () => {
    // The RSC entry should shadow renderToReadableStream with a wrapper that
    // rewrites Flight HL hint "stylesheet" → "style" at the stream source,
    // so all consumers (SSR embed, client-side nav, server actions) get clean data.
    const route: AppRoute = {
      pattern: "/",
      pagePath: "/tmp/test/app/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      notFoundPaths: [null],
      forbiddenPaths: [],
      forbiddenPath: null,
      unauthorizedPaths: [],
      unauthorizedPath: null,
      routeSegments: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
      patternParts: ["/"],
    };
    const code = generateRscEntry("/tmp/test/app", [route]);
    expect(code).toContain("_renderToReadableStream");
    expect(code).toContain("createRscRenderer");
    expect(code).toContain(
      "const renderToReadableStream = createRscRenderer(_renderToReadableStream",
    );
  });
});
// ── Client reference preloading (Issue #256) ─────────────────────────────────
//
// On the first SSR request after server start, client reference modules are
// loaded lazily via async import(). The memoize cache in @vitejs/plugin-rsc is
// cold, so __vite_rsc_client_require__ returns an unresolved Promise. Without
// <Suspense> wrapping the root shell, React SSR rejects and the server returns
// 500. Subsequent requests work because the memoize cache is warm.
//
// Fix: the SSR entry eagerly preloads all client reference modules before
// renderToReadableStream runs, warming the memoize cache on every request.
