import { describe, expect, it } from "vite-plus/test";
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
      siblingIntercepts: [],
    };
    const code = generateRscEntry("/tmp/test/app", [route]);
    expect(code).toContain("_renderToReadableStream");
    expect(code).toContain("createRscRenderer");
    expect(code).toContain(
      "const renderToReadableStream = createRscRenderer(_renderToReadableStream",
    );
  });
});
