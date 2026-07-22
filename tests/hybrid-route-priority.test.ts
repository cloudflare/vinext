import { describe, expect, it } from "vite-plus/test";
import { compareHybridRoutePatterns } from "../packages/vinext/src/routing/utils.js";
import {
  pagesRouteHasPriorityOverAppRoute,
  validateHybridRouteConflicts,
} from "../packages/vinext/src/server/hybrid-route-priority.js";

describe("compareHybridRoutePatterns", () => {
  it("lets a more specific Pages dynamic route beat an App root catch-all", () => {
    // Ported from Next.js: test/e2e/app-dir/use-params/use-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts
    //
    // Next.js's DefaultRouteMatcherManager merges Pages and App matchers before
    // sorting dynamic routes, so /pages-dir/[dynamic] owns /pages-dir/foobar
    // ahead of app/[...path].
    expect(compareHybridRoutePatterns("/pages-dir/:dynamic", true, "/:path+", true)).toBe("pages");
  });

  it("keeps a more specific App static route ahead of a Pages catch-all", () => {
    expect(compareHybridRoutePatterns("/:path+", true, "/dashboard", false)).toBe("app");
  });

  it("lets a static Pages route win over a dynamic App catch-all", () => {
    // E.g. Pages has a literal `/about` page, App only has a catch-all.
    // The literal Pages hit must own the request even though the App
    // catch-all matches the same URL.
    expect(compareHybridRoutePatterns("/about", false, "/:path+", true)).toBe("pages");
  });

  it("rejects an identical static App and Pages route", () => {
    expect(() => compareHybridRoutePatterns("/", false, "/", false)).toThrow(
      "Conflicting app and page routes",
    );
  });

  it("retains Pages provider order after merged route validation", () => {
    expect(compareHybridRoutePatterns("/:slug", true, "/:id", true)).toBe("pages");
  });

  it("lets a static-prefix Pages catch-all beat a bare App catch-all", () => {
    // /_sites/:slug* must beat /:slug*. `routePrecedence` reduces the
    // static-prefix score by 50 per segment, so the Pages route scores
    // 1951 and the App route scores 2000. The hand-copied client
    // comparator missed this reduction and reversed the answer; the
    // shared comparator's Next.js-style segment ordering gets it right.
    expect(compareHybridRoutePatterns("/_sites/:slug*", true, "/:slug*", true)).toBe("pages");
  });

  it("lets a static-prefix Pages dynamic beat a bare App dynamic", () => {
    // Same shape as the catch-all case but for a plain dynamic segment.
    expect(compareHybridRoutePatterns("/_sites/:subdomain", true, "/:subdomain", true)).toBe(
      "pages",
    );
  });

  it("lets a Pages dynamic with a static prefix beat an App dynamic with a static prefix", () => {
    // Both have a static prefix of length 1. The Pages route has a more
    // specific infix (`/_sites/blog/:slug`) versus a bare infix dynamic
    // (`/_sites/:slug`); the static-prefix reduction cancels but the
    // infix-static bonus inside `routePrecedence` puts the more specific
    // Pages route ahead.
    expect(compareHybridRoutePatterns("/_sites/blog/:slug", true, "/_sites/:slug", true)).toBe(
      "pages",
    );
  });

  it("prioritizes an earlier static App segment over a later static Pages segment", () => {
    // Next.js sorts dynamic pathnames structurally, traversing a static child
    // before a dynamic child at the first differing segment.
    // Ported from Next.js: test/unit/page-route-sorter.test.ts
    expect(compareHybridRoutePatterns("/:section/details", true, "/account/:tab", true)).toBe(
      "app",
    );
  });

  it("keeps an exact App dynamic route ahead of a Pages optional catch-all", () => {
    expect(compareHybridRoutePatterns("/:section/:rest*", true, "/:section", true)).toBe("app");
  });
});

describe("validateHybridRouteConflicts", () => {
  it("rejects identical static routes", () => {
    expect(() =>
      validateHybridRouteConflicts(
        [{ isDynamic: false, pattern: "/" }],
        [{ isDynamic: false, pattern: "/" }],
      ),
    ).toThrow("Conflicting app and page file was found");
  });

  it("uses the Next.js slug-name error for structurally identical dynamic routes", () => {
    expect(() =>
      validateHybridRouteConflicts(
        [{ isDynamic: true, pattern: "/:slug" }],
        [{ isDynamic: true, pattern: "/:id" }],
      ),
    ).toThrow("different slug names for the same dynamic path");
  });

  it("rejects cross-router apex and optional catch-all collisions", () => {
    expect(() =>
      validateHybridRouteConflicts(
        [{ isDynamic: false, pattern: "/" }],
        [{ isDynamic: true, pattern: "/:all*" }],
      ),
    ).toThrow("same specificity as a optional catch-all route");
  });

  it("reports exact conflict source files", () => {
    expect(() =>
      validateHybridRouteConflicts(
        [{ isDynamic: false, pattern: "/", sourcePath: "pages/index.tsx" }],
        [{ isDynamic: false, pattern: "/", sourcePath: "app/page.tsx" }],
      ),
    ).toThrow('"pages/index.tsx" - "app/page.tsx"');
  });
});

describe("hybrid App Router + Pages Router route priority", () => {
  it("lets a more specific Pages dynamic route beat an App root catch-all", () => {
    // Ported from Next.js: test/e2e/app-dir/use-params/use-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts
    //
    // Next.js's DefaultRouteMatcherManager merges Pages and App matchers before
    // sorting dynamic routes, so /pages-dir/[dynamic] owns /pages-dir/foobar
    // ahead of app/[...path].
    expect(
      pagesRouteHasPriorityOverAppRoute(
        { isDynamic: true, pattern: "/pages-dir/:dynamic" },
        { isDynamic: true, pattern: "/:path+" },
      ),
    ).toBe(true);
  });

  it("keeps a more specific App static route ahead of a Pages catch-all", () => {
    expect(
      pagesRouteHasPriorityOverAppRoute(
        { isDynamic: true, pattern: "/:path+" },
        { isDynamic: false, pattern: "/dashboard" },
      ),
    ).toBe(false);
  });

  it("rejects an identical static App and Pages route", () => {
    expect(() =>
      pagesRouteHasPriorityOverAppRoute(
        { isDynamic: false, pattern: "/" },
        { isDynamic: false, pattern: "/" },
      ),
    ).toThrow("Conflicting app and page routes");
  });

  it("retains Pages provider order after merged route validation", () => {
    expect(
      pagesRouteHasPriorityOverAppRoute(
        { isDynamic: true, pattern: "/:slug" },
        { isDynamic: true, pattern: "/:id" },
      ),
    ).toBe(true);
  });
});
