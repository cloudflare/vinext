import { describe, expect, it } from "vitest";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

describe("generateRscEntry ISR code generation", () => {
  // Minimal route list — only the generated ISR guard logic matters here
  const minimalRoutes = [
    {
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
      forbiddenPaths: [],
      forbiddenPath: null,
      unauthorizedPaths: [],
      unauthorizedPath: null,
      routeSegments: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
    },
  ] as any[];

  it('generated code contains process.env.NODE_ENV === "production" guard for ISR cache read', () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain('process.env.NODE_ENV === "production"');
  });

  it("generated handler delegates request and ctx handling to createAppRscHandler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain("createAppRscHandler");
    expect(code).toContain("export default createAppRscHandler({");
  });

  it("generated code stores root layout params separately from leaf params", () => {
    const routes = [
      {
        ...minimalRoutes[0],
        pattern: "/[lang]/[locale]/other/[slug]",
        patternParts: [":lang", ":locale", "other", ":slug"],
        params: ["lang", "locale", "slug"],
        rootParamNames: ["lang", "locale"],
        routeSegments: ["[lang]", "[locale]", "other", "[slug]"],
        layoutTreePositions: [2],
      },
    ] as any[];

    const code = generateRscEntry("/tmp/test/app", routes);

    // The user-declared rootParamNames must flow through to the route's entry,
    // narrower than the full leaf params list. The typed RSC handler owns
    // setting the per-request root params from this route shape.
    expect(code).toContain('rootParamNames: ["lang","locale"]');
    expect(code).not.toContain('rootParamNames: ["lang","locale","slug"]');
    expect(code).toContain("rootParamNamesByPattern: rootParamNamesMap");
    expect(code).not.toContain("__setRootParams(__pickRootParams(params, route.rootParamNames));");
    expect(code).toContain("clearAppRequestContext as __clearRequestContext");
    expect(code).toContain("server/app-request-context.js");
    expect(code).not.toContain("function __clearRequestContext() {");
  });

  it("root params runtime getter returns current request values", async () => {
    const { getRootParam, pickRootParams, setRootParams } =
      await import("../packages/vinext/src/shims/root-params.js");

    expect(pickRootParams({ lang: "en", locale: "us", slug: "post" }, ["lang", "locale"])).toEqual({
      lang: "en",
      locale: "us",
    });

    setRootParams({ lang: "en", locale: "us" });

    await expect(getRootParam("lang")).resolves.toBe("en");
    await expect(getRootParam("locale")).resolves.toBe("us");
    await expect(getRootParam("slug")).resolves.toBeUndefined();

    setRootParams(null);
  });

  it("generated code threads intercept layout modules through slot overrides", () => {
    const routeWithInterceptLayouts: AppRoute = {
      errorPath: null,
      forbiddenPaths: [],
      forbiddenPath: null,
      isDynamic: false,
      layoutErrorPaths: [null],
      layouts: ["/tmp/test/app/layout.tsx"],
      layoutTreePositions: [0],
      loadingPath: null,
      notFoundPath: null,
      notFoundPaths: [null],
      pagePath: "/tmp/test/app/page.tsx",
      parallelSlots: [
        {
          defaultPath: "/tmp/test/app/@modal/default.tsx",
          errorPath: null,
          interceptingRoutes: [
            {
              convention: ".",
              layoutPaths: ["/tmp/test/app/@modal/(.)explicit-layout/layout.tsx"],
              pagePath: "/tmp/test/app/@modal/(.)explicit-layout/deeper/page.tsx",
              params: [],
              targetPattern: "/explicit-layout/deeper",
              sourceMatchPattern: "/",
            },
          ],
          key: "modal@@modal",
          layoutIndex: 0,
          layoutPath: "/tmp/test/app/@modal/layout.tsx",
          loadingPath: null,
          name: "modal",
          hasPage: false,
          ownerDir: "/tmp/test/app/@modal",
          ownerTreePath: "/",
          pagePath: null,
          routeSegments: null,
        },
      ],
      params: [],
      pattern: "/",
      patternParts: [],
      routePath: null,
      routeSegments: [],
      templates: [],
      templateTreePositions: [],
      unauthorizedPaths: [],
      unauthorizedPath: null,
      siblingIntercepts: [],
    };

    const code = generateRscEntry("/tmp/test/app", [routeWithInterceptLayouts]);

    // Intercept-layout modules must be wired into the route's intercept entry
    // (mod_N is the generator's import alias scheme — `interceptLayouts: [mod_`
    // confirms a module reference, not the original layout path string).
    expect(code).toContain("interceptLayouts: [mod_");
    expect(code).not.toMatch(/interceptLayouts:\s*\[\s*"\/tmp\/test\/app/);
  });

  it("generated code seeds root params around prerender generateStaticParams", () => {
    const routeWithRootParams: AppRoute = {
      errorPath: null,
      forbiddenPath: null,
      forbiddenPaths: [],
      isDynamic: true,
      layoutErrorPaths: [null],
      layouts: ["/tmp/test/app/[locale]/layout.tsx"],
      layoutTreePositions: [1],
      loadingPath: null,
      notFoundPath: null,
      notFoundPaths: [null],
      pagePath: "/tmp/test/app/[locale]/blog/[slug]/page.tsx",
      parallelSlots: [],
      params: ["locale", "slug"],
      pattern: "/:locale/blog/:slug",
      patternParts: [":locale", "blog", ":slug"],
      rootParamNames: ["locale"],
      routePath: null,
      routeSegments: ["[locale]", "blog", "[slug]"],
      templates: [],
      templateTreePositions: [],
      unauthorizedPaths: [],
      unauthorizedPath: null,
      siblingIntercepts: [],
    };

    const code = generateRscEntry("/tmp/test/app", [routeWithRootParams]);

    // The user-declared dynamic-segment names must flow into the generated
    // entry so prerender static-params know which params are root-scoped.
    expect(code).toContain('"/:locale/blog/:slug"');
    expect(code).toContain('["locale"]');
  });

  it("generated code exposes prerender cache seeding from the RSC module graph", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);

    expect(code).toContain("seedMemoryCacheFromPrerender as __seedMemoryCacheFromPrerender");
    expect(code).toContain("isrSetPrerenderedAppPage as __isrSetPrerenderedAppPage");
    expect(code).toContain("export function seedMemoryCacheFromPrerender(serverDir)");
    expect(code).toContain("buildAppPageHtmlKey(pathname)");
    expect(code).toContain("return __isrHtmlKey(pathname)");
    expect(code).toContain("buildAppPageRscKey(pathname)");
    expect(code).toContain("return __isrRscKey(pathname)");
    expect(code).toContain("writeAppPageEntry(key, data, metadata)");
    expect(code).toContain("return __isrSetPrerenderedAppPage(key, data, metadata)");
  });

  it("generated code delegates server-action header handling to the typed handler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain("handleServerActionRequest({");
    expect(code).toContain("actionId,");
  });
});
