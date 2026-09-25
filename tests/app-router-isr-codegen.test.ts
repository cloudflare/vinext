import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import { describe, expect, it } from "vite-plus/test";
import vm from "node:vm";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "../packages/vinext/src/server/app-rsc-route-matching.js";
import * as appSegmentConfig from "../packages/vinext/src/server/app-segment-config.js";
import {
  resolveAppPageGenerateStaticParamsSources,
  validateAppPageDynamicParams,
} from "../packages/vinext/src/server/app-page-request.js";
import {
  appRouter,
  invalidateAppRouteCache,
  type AppRoute,
} from "../packages/vinext/src/routing/app-router.js";

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

  it("classifies static generation from the route's own segments and slots", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    // The generateStaticParams walk reads the main tree and every slot branch,
    // including each slot's owner position and whether it (or children)
    // renders its default.
    expect(code)
      .toContain(`hasGenerateStaticParams: __hasAppPageGenerateStaticParamsAtLastDynamicSegment({
      childrenSlot: route.childrenSlot,
      layouts: route.layouts,
      layoutTreePositions: route.layoutTreePositions,
      page: route.page,
      parallelBranches: segmentConfigBranches,
      routeSegments: route.routeSegments,
    }),`);
    // An intercept swaps a sibling slot for its default.
    expect(code).toContain("default: slot.default,");
    expect(code).toContain("isDefault: !slot.page,");
    expect(code).toContain("ownerTreePosition: slot.ownerTreePosition,");
    // Any segment's generator still sets the route's revalidate default.
    expect(code).toContain("hasAnyGenerateStaticParams: __generateStaticParams.length > 0,");
    // ...and an intercepting tree's generators set its own, read from Next.js's
    // tree for the intercepting route.
    expect(code).toContain(`function __resolveRouteHasAnyGenerateStaticParams(route, intercept) {
  const tree = __resolveRouteInterceptTree(route, intercept);
  return __hasAppPageAnyGenerateStaticParams({
    childrenSlot: tree.route.childrenSlot,
    layouts: tree.route.layouts,
    layoutTreePositions: tree.route.layoutTreePositions,
    page: tree.route.page,
    parallelBranches: tree.branches,
    routeSegments: tree.route.routeSegments,
  });
}`);
    expect(code).toContain(`resolveRouteHasAnyGenerateStaticParams(targetRoute, intercept) {
        return __resolveRouteHasAnyGenerateStaticParams(targetRoute, intercept);
      },`);
    // The runtime merges across the whole loader tree, slots included.
    expect(code).toContain(`isStaticGenerationEdgeRuntime: __isEdgeRuntime(
      __resolveAppPageStaticGenerationRuntime(
        __collectAppPageStaticGenerationRuntimes({
          childrenSlot: route.childrenSlot,
          layouts: route.layouts,
          layoutTreePositions: route.layoutTreePositions,
          page: route.page,
          parallelBranches: segmentConfigBranches,
          routeSegments: route.routeSegments,
        }),
      ),
    ),`);
    // The matched route and any other route dispatch renders, such as an
    // intercept's source, are classified from the same inputs.
    expect(code).toContain(
      "const __staticGeneration = __resolveRouteStaticGeneration(route, __segmentConfigBranches);",
    );
    expect(code).toContain("hasGenerateStaticParams: __staticGeneration.hasGenerateStaticParams,");
    expect(code).toContain(
      "isStaticGenerationEdgeRuntime: __staticGeneration.isStaticGenerationEdgeRuntime,",
    );
    expect(code).toContain(`resolveRouteStaticEligible(targetRoute, intercept) {
        return __resolveRouteStaticEligible(targetRoute, intercept);
      },`);
    // A direct intercepted RSC response classifies the source's tree with the
    // intercepting branch in the intercepted slot, and is dynamic when the
    // intercepted route is.
    expect(code).toContain(
      `slotIndex: Object.keys(route.slots ?? {}).indexOf(intercept.interceptSlotKey),`,
    );
    // ...and its own folder's children for that folder's default, which only
    // the matched intercept carries.
    expect(code).toContain("interceptOwnerDefault: intercept.interceptOwnerDefault,");
    // A sibling-page intercept is told apart from a slot the source lacks.
    expect(code).toContain(
      "isSiblingPageIntercept: intercept.interceptSlotKey === __SIBLING_PAGE_INTERCEPT_SLOT_KEY,",
    );
    // Next.js's tree swaps the other slots for their defaults, but vinext
    // renders their active pages, so both trees must be static.
    expect(code).toContain(`  return [false, true].every((keepActiveSiblings) =>
    __isRouteTreeStaticEligible(`);
    expect(code).toContain("__resolveRouteInterceptTree(route, intercept, keepActiveSiblings),");
    expect(code).toContain("    keepActiveSiblings,\n");
    expect(code).toContain("const effectiveRoute = tree?.route ?? route;");
    // The direct intercept render's dynamic config, revalidate and fetchCache
    // come from the same trees: Next.js's, and the active siblings vinext
    // renders in place of its defaults.
    expect(code).toContain(`resolveRouteFetchCacheMode(targetRoute, intercept) {
        return __resolveRouteFetchCacheMode(targetRoute, intercept);
      },`);
    expect(code).toContain(`function __resolveRouteFetchCacheMode(route, intercept) {
  if (intercept) {
    return __resolveRouteInterceptSegmentConfig(route, intercept).fetchCache ?? null;
  }`);
    expect(code).toContain(
      "return __resolveRouteInterceptSegmentConfig(route, intercept).dynamicConfig ?? null;",
    );
    expect(code).toContain(
      "return __resolveRouteInterceptSegmentConfig(route, intercept).revalidateSeconds;",
    );
    expect(code)
      .toContain(`  const [interceptTree, renderedTree] = [false, true].map((keepActiveSiblings) => {
    const tree = __resolveRouteInterceptTree(route, intercept, keepActiveSiblings);`);
    expect(code).toContain(
      "return __resolveAppPageInterceptSegmentConfig(interceptTree, renderedTree);",
    );
    expect(code).toContain(`resolveRouteDynamicConfig(targetRoute, intercept) {
        return __resolveRouteDynamicConfig(targetRoute, intercept);
      },`);
    expect(code).toContain(`resolveRouteRevalidateSeconds(targetRoute, intercept) {
        return __resolveRouteRevalidateSeconds(targetRoute, intercept);
      },`);
    // A Server Action rerender of that response resolves the same trees, with
    // the owner default a slot intercept's tree renders.
    for (const name of ["FetchCacheMode", "RevalidateSeconds", "DynamicConfig"]) {
      expect(code.split(`return __resolveRoute${name}(targetRoute, intercept);`)).toHaveLength(3);
    }
    expect(code).toContain("interceptOwnerDefault: intercept.ownerDefault,");
    // ...and so does the dynamic stale time its RSC metadata advertises.
    expect(code).toContain(`function __resolveRouteDynamicStaleTimeSeconds(route, intercept) {
  if (intercept) {
    return __resolveRouteInterceptSegmentConfig(route, intercept).dynamicStaleTimeSeconds;
  }
  return __resolveRouteSegmentConfig(route, __resolveRouteSegmentConfigBranches(route))
    .dynamicStaleTimeSeconds;
}`);
    expect(code).toContain(`resolveRouteDynamicStaleTimeSeconds(targetRoute, intercept) {
        return __resolveRouteDynamicStaleTimeSeconds(targetRoute, intercept);
      },`);
    // A slot intercept whose slot the source lacks leaves the source's tree as
    // rendered, so the unused intercepted route's dynamism doesn't apply.
    expect(code).toContain(
      "if (!__isAppPageInterceptAttached(__resolveRouteInterceptTreeOptions(route, intercept))) {",
    );
    // Its headers precede its render, so the direct intercept probes run what
    // that render includes for the request's mounted slots and render mode.
    expect(code).toContain(`return Promise.all(__buildAppPageInterceptSourceProbes({
          route: sourceRoute,
          pageComponent: sourceRoute.page?.default,
          intercept: __probeIntercept,
          sourceParams,
          // The intercepted render matches inherited slots' params against
          // the request path, as buildPageElements does.
          slotParamOverrides: __resolveSlotParamOverrides(sourceRoute, cleanPathname),
          searchParams: sourceSearchParams,
          mountedSlotsHeader,
          renderMode,
          makeThenableParams,
        }));`);
    expect(code).toContain(`  return __isAppPageStaticEligible({
    ...__resolveRouteStaticGeneration(effectiveRoute, segmentConfigBranches),
    dynamicConfig: segmentConfig.dynamicConfig,
    isDynamicRoute: intercept
      ? __isAppPageInterceptTargetDynamic(intercept.interceptTargetPatternParts)
      : route.isDynamic,
    revalidateSeconds: segmentConfig.revalidateSeconds,
  });`);
  });

  it("classifies a slot intercept the source can't take by the source alone", () => {
    // Run the generated classification against the real segment-config helpers.
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    const start = code.indexOf("function __resolveRouteSegmentConfigBranches(route) {");
    const end = code.indexOf("\n}\n", code.indexOf("function __isRouteTreeStaticEligible(")) + 3;
    const resolveRouteStaticEligible = vm.runInNewContext(
      `${code.slice(start, end)}\n__resolveRouteStaticEligible;`,
      {
        __collectAppPageStaticGenerationRuntimes:
          appSegmentConfig.collectAppPageStaticGenerationRuntimes,
        __hasAppPageGenerateStaticParamsAtLastDynamicSegment:
          appSegmentConfig.hasAppPageGenerateStaticParamsAtLastDynamicSegment,
        __isAppPageInterceptTargetDynamic: appSegmentConfig.isAppPageInterceptTargetDynamic,
        __isAppPageInterceptAttached: appSegmentConfig.isAppPageInterceptAttached,
        __isAppPageStaticEligible: appSegmentConfig.isAppPageStaticEligible,
        __isEdgeRuntime: appSegmentConfig.isEdgeRuntime,
        __resolveAppPageInterceptTree: appSegmentConfig.resolveAppPageInterceptTree,
        __resolveAppPageSegmentConfig: appSegmentConfig.resolveAppPageSegmentConfig,
        __resolveAppPageStaticGenerationRuntime:
          appSegmentConfig.resolveAppPageStaticGenerationRuntime,
        __SIBLING_PAGE_INTERCEPT_SLOT_KEY: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
      },
    ) as (route: unknown, intercept?: unknown) => boolean;
    // A static app/feed intercepting the dynamic app/photos/[id] through
    // app/feed/@modal/(..)photos/[id], which has no generateStaticParams.
    const feed = {
      childrenSlot: { ownerTreePath: "/feed", state: "active" },
      isDynamic: false,
      layouts: [{}, {}],
      layoutTreePositions: [0, 1],
      page: {},
      routeSegments: ["feed"],
      slots: {
        "modal@app/feed/@modal": {
          default: {},
          layout: null,
          name: "modal",
          ownerTreePosition: 1,
          page: null,
          routeSegments: [],
        },
      },
    };
    const intercept = {
      interceptBranchSegments: ["(..)photos", "[id]"],
      interceptPage: {},
      interceptSlotKey: "modal@app/feed/@modal",
      interceptTargetPatternParts: ["photos", ":id"],
    };

    expect(resolveRouteStaticEligible(feed)).toBe(true);
    expect(resolveRouteStaticEligible(feed, intercept)).toBe(false);
    // Next.js's isDynamicRoute classifies the intercepting route by the route
    // its folders intercept: app/feed/@modal/(..)about intercepts /about,
    // even where app/[slug] is the route that matches it...
    expect(
      resolveRouteStaticEligible(feed, {
        ...intercept,
        interceptBranchSegments: ["(..)about"],
        interceptTargetPatternParts: ["about"],
      }),
    ).toBe(true);
    // ...and app/[lang]/feed/@modal/(...)photos intercepts the static /photos.
    const langFeed = {
      ...feed,
      childrenSlot: { ownerTreePath: "/[lang]/feed", state: "active" },
      isDynamic: true,
      layouts: [{}, {}, {}],
      layoutTreePositions: [0, 1, 2],
      routeSegments: ["[lang]", "feed"],
      slots: {
        "modal@app/feed/@modal": { ...feed.slots["modal@app/feed/@modal"], ownerTreePosition: 2 },
      },
    };
    expect(resolveRouteStaticEligible(langFeed)).toBe(false);
    expect(
      resolveRouteStaticEligible(langFeed, {
        ...intercept,
        interceptBranchSegments: ["(...)photos"],
        interceptTargetPatternParts: ["photos"],
      }),
    ).toBe(true);
    // A route-group variant of app/feed without @modal renders its own page.
    expect(resolveRouteStaticEligible({ ...feed, slots: {} }, intercept)).toBe(true);
    expect(
      resolveRouteStaticEligible(
        { ...feed, slots: {} },
        { ...intercept, interceptSlotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY },
      ),
    ).toBe(false);
  });

  it("gates a current-route intercept's params by the intercepting tree's own dynamicParams and generators", async () => {
    // Run the generated resolvers against the real segment-config helpers.
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain(`resolveRouteDynamicParamsConfig(targetRoute, intercept) {
        return __resolveRouteDynamicParamsConfig(targetRoute, intercept);
      },`);
    expect(code).toContain(`resolveRouteGenerateStaticParams(targetRoute, intercept) {
        return __resolveRouteGenerateStaticParams(targetRoute, intercept);
      },`);
    // The matched route's own gate reads the same generator walk.
    expect(code).toContain(
      "const __generateStaticParams = __resolveRouteGenerateStaticParams(route);",
    );
    const start = code.indexOf("function __resolveRouteSegmentConfigBranches(route) {");
    const end = code.indexOf("\n}\n", code.indexOf("function __isRouteTreeStaticEligible(")) + 3;
    const [resolveDynamicParamsConfig, resolveGenerateStaticParams] = vm.runInNewContext(
      `${code.slice(start, end)}\n[__resolveRouteDynamicParamsConfig, __resolveRouteGenerateStaticParams];`,
      {
        __isAppPageInterceptTargetDynamic: appSegmentConfig.isAppPageInterceptTargetDynamic,
        __isAppPageInterceptAttached: appSegmentConfig.isAppPageInterceptAttached,
        __resolveAppPageGenerateStaticParamsSources: resolveAppPageGenerateStaticParamsSources,
        __resolveAppPageInterceptTree: appSegmentConfig.resolveAppPageInterceptTree,
        __resolveAppPageSegmentConfig: appSegmentConfig.resolveAppPageSegmentConfig,
        __SIBLING_PAGE_INTERCEPT_SLOT_KEY: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
      },
    ) as [
      (route: unknown, intercept: unknown) => boolean | undefined,
      (
        route: unknown,
        intercept?: unknown,
      ) => ReturnType<typeof resolveAppPageGenerateStaticParamsSources>,
    ];
    // app/feed/[slug]/page.tsx and app/feed/[slug]/@modal/(..)[slug]/page.tsx,
    // which intercepts /feed/[slug] from itself. The intercepting tree drops
    // the route's page for app/feed/[slug]/default.tsx.
    function resolveGate(page: object, interceptPage: object, hasModalSlot = true) {
      const route = {
        childrenSlot: { ownerTreePath: "/feed/[slug]", state: "active" },
        isDynamic: true,
        layouts: [{}],
        layoutTreePositions: [0],
        page,
        patternParts: ["feed", ":slug"],
        routeSegments: ["feed", "[slug]"],
        slots: hasModalSlot
          ? {
              "modal@app/feed/[slug]/@modal": {
                default: {},
                layout: null,
                name: "modal",
                ownerTreePosition: 2,
                page: null,
                routeSegments: [],
              },
            }
          : {},
      };
      const intercept = {
        interceptBranchSegments: ["(..)[slug]"],
        interceptOwnerDefault: {},
        interceptPage,
        interceptSlotKey: "modal@app/feed/[slug]/@modal",
      };
      const dynamicParamsConfig = resolveDynamicParamsConfig(route, intercept);
      const generateStaticParams = resolveGenerateStaticParams(route, intercept);
      return (slug: string) =>
        validateAppPageDynamicParams({
          enforceStaticParamsOnly: dynamicParamsConfig === false,
          generateStaticParams,
          isDynamicRoute: true,
          params: { slug },
        });
    }
    const generate = (slug: string) => () => [{ slug }];
    const allowsKnown = { dynamicParams: false, generateStaticParams: generate("known") };
    const allowsOther = { dynamicParams: false, generateStaticParams: generate("other") };

    // The intercepting tree's dynamicParams = false over a route that allows
    // fallback params.
    const interceptForbids = resolveGate({}, allowsKnown);
    await expect(interceptForbids("known")).resolves.toBeNull();
    await expect(interceptForbids("unknown")).resolves.toMatchObject({ status: 404 });
    // An intercepting tree that allows fallback params over a route that
    // doesn't.
    await expect(resolveGate(allowsKnown, {})("unknown")).resolves.toBeNull();
    // Both forbid them, but only the intercepting tree's generators apply.
    const bothForbid = resolveGate(allowsKnown, allowsOther);
    await expect(bothForbid("other")).resolves.toBeNull();
    await expect(bothForbid("known")).resolves.toMatchObject({ status: 404 });
    // A route-group variant without @modal renders its own page.
    const unattached = resolveGate(allowsKnown, allowsOther, false);
    await expect(unattached("known")).resolves.toBeNull();
    await expect(unattached("other")).resolves.toMatchObject({ status: 404 });
  });

  it("gates a renamed intercepting param by every param of the intercepting route's path", async () => {
    // Run the generated resolvers against the real segment-config helpers.
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    const start = code.indexOf("function __resolveRouteSegmentConfigBranches(route) {");
    const end = code.indexOf("\n}\n", code.indexOf("function __isRouteTreeStaticEligible(")) + 3;
    const [resolveDynamicParamsConfig, resolveGenerateStaticParams] = vm.runInNewContext(
      `${code.slice(start, end)}\n[__resolveRouteDynamicParamsConfig, __resolveRouteGenerateStaticParams];`,
      {
        __isAppPageInterceptTargetDynamic: appSegmentConfig.isAppPageInterceptTargetDynamic,
        __isAppPageInterceptAttached: appSegmentConfig.isAppPageInterceptAttached,
        __resolveAppPageGenerateStaticParamsSources: resolveAppPageGenerateStaticParamsSources,
        __resolveAppPageInterceptTree: appSegmentConfig.resolveAppPageInterceptTree,
        __resolveAppPageSegmentConfig: appSegmentConfig.resolveAppPageSegmentConfig,
        __SIBLING_PAGE_INTERCEPT_SLOT_KEY: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
      },
    ) as [
      (route: unknown, intercept: unknown) => boolean | undefined,
      (
        route: unknown,
        intercept: unknown,
      ) => ReturnType<typeof resolveAppPageGenerateStaticParamsSources>,
    ];
    // app/feed/[slug]/layout.tsx generates slug "a", and
    // app/feed/[slug]/@modal/(..)[photo]/page.tsx generates photo "known".
    // Next.js serves /feed/known from /feed/a as /feed/[slug]/(..)[photo],
    // whose path takes slug from the source and photo from the URL, and
    // prerenders /feed/a/(..)known.
    const route = {
      childrenSlot: { ownerTreePath: "/feed/[slug]", state: "active" },
      isDynamic: true,
      layouts: [{ generateStaticParams: () => [{ slug: "a" }] }],
      layoutTreePositions: [2],
      page: {},
      patternParts: ["feed", ":slug"],
      routeSegments: ["feed", "[slug]"],
      slots: {
        "modal@app/feed/[slug]/@modal": {
          default: {},
          layout: null,
          name: "modal",
          ownerTreePosition: 2,
          page: null,
          routeSegments: [],
        },
      },
    };
    const intercept = {
      interceptBranchSegments: ["(..)[photo]"],
      interceptOwnerDefault: {},
      interceptPage: { dynamicParams: false, generateStaticParams: () => [{ photo: "known" }] },
      interceptSlotKey: "modal@app/feed/[slug]/@modal",
    };
    const dynamicParamsConfig = resolveDynamicParamsConfig(route, intercept);
    const generateStaticParams = resolveGenerateStaticParams(route, intercept);
    const validate = (params: Record<string, string>) =>
      validateAppPageDynamicParams({
        enforceStaticParamsOnly: dynamicParamsConfig === false,
        generateStaticParams,
        isDynamicRoute: true,
        params,
      });

    await expect(validate({ photo: "known", slug: "a" })).resolves.toBeNull();
    await expect(validate({ photo: "unknown", slug: "a" })).resolves.toMatchObject({
      status: 404,
    });
    await expect(validate({ photo: "known", slug: "b" })).resolves.toMatchObject({
      status: 404,
    });
  });

  it("exempts a current-route intercept's params gate only by the intercepting tree's own force-dynamic", () => {
    // Run the generated resolvers against the real segment-config helpers.
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain(`resolveRouteInterceptTreeDynamicConfig(targetRoute, intercept) {
        return __resolveRouteInterceptTreeDynamicConfig(targetRoute, intercept);
      },`);
    const start = code.indexOf("function __resolveRouteSegmentConfigBranches(route) {");
    const end = code.indexOf("\n}\n", code.indexOf("function __isRouteTreeStaticEligible(")) + 3;
    const [resolveInterceptSegmentConfig, resolveInterceptTreeDynamicConfig] = vm.runInNewContext(
      `${code.slice(start, end)}\n[__resolveRouteInterceptSegmentConfig, __resolveRouteInterceptTreeDynamicConfig];`,
      {
        __resolveAppPageInterceptSegmentConfig:
          appSegmentConfig.resolveAppPageInterceptSegmentConfig,
        __resolveAppPageInterceptTree: appSegmentConfig.resolveAppPageInterceptTree,
        __resolveAppPageSegmentConfig: appSegmentConfig.resolveAppPageSegmentConfig,
        __SIBLING_PAGE_INTERCEPT_SLOT_KEY: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
      },
    ) as [
      (route: unknown, intercept: unknown) => { dynamicConfig?: string },
      (route: unknown, intercept: unknown) => string | null,
    ];
    // app/feed/[slug]/page.tsx and app/feed/[slug]/@modal/(..)[slug]/page.tsx,
    // which intercepts /feed/[slug] from itself. Next.js's intercepting tree
    // has app/feed/[slug]/default.tsx where vinext renders the route's page.
    function resolveDynamicConfigs(page: object, interceptPage: object) {
      const route = {
        childrenSlot: { ownerTreePath: "/feed/[slug]", state: "active" },
        isDynamic: true,
        layouts: [{}],
        layoutTreePositions: [0],
        page,
        patternParts: ["feed", ":slug"],
        routeSegments: ["feed", "[slug]"],
        slots: {
          "modal@app/feed/[slug]/@modal": {
            default: {},
            layout: null,
            name: "modal",
            ownerTreePosition: 2,
            page: null,
            routeSegments: [],
          },
        },
      };
      const intercept = {
        interceptBranchSegments: ["(..)[slug]"],
        interceptOwnerDefault: {},
        interceptPage,
        interceptSlotKey: "modal@app/feed/[slug]/@modal",
      };
      return {
        rendered: resolveInterceptSegmentConfig(route, intercept).dynamicConfig,
        route: resolveInterceptTreeDynamicConfig(route, intercept),
      };
    }
    const forceDynamic = { dynamic: "force-dynamic" };

    // The route's force-dynamic page makes the render dynamic, not the
    // intercepting route, whose manifest entry keeps its params gate.
    expect(resolveDynamicConfigs(forceDynamic, { dynamicParams: false })).toEqual({
      rendered: "force-dynamic",
      route: null,
    });
    expect(resolveDynamicConfigs({}, forceDynamic)).toEqual({
      rendered: "force-dynamic",
      route: "force-dynamic",
    });
  });

  it("generated handler delegates request and ctx handling to createAppRscHandler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain("createAppRscHandler");
    expect(code).toContain("const __appRscHandler = createAppRscHandler({");
    expect(code).toContain("export default __appRscHandler;");
  });

  it("configures the cache through the lightweight handler runtime", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes);
    expect(code).toContain(
      'configureMemoryCacheHandler as __configureMemoryCacheHandler } from "vinext/shims/cache-handler"',
    );
    expect(code).not.toContain(
      'configureMemoryCacheHandler as __configureMemoryCacheHandler } from "next/cache"',
    );
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

    // Intercept-layout modules are wired into the route's intercept entry as
    // lazy loaders: `interceptLayouts` holds `null` placeholders and the
    // `__loadInterceptLayouts` array carries the `load_N` import thunks
    // (load_N/mod_N are the generator's alias schemes — a module reference, not
    // the original layout path string).
    expect(code).toContain("interceptLayouts: [null]");
    expect(code).toMatch(/__loadInterceptLayouts:\s*\[load_\d+\]/);
    expect(code).not.toMatch(/interceptLayouts:\s*\[\s*"\/tmp\/test\/app/);
    expect(code).not.toMatch(/__loadInterceptLayouts:\s*\[\s*"\/tmp\/test\/app/);
  });

  it("generated code loads the owner's default only with a slot intercept", async () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-owner-default-"));
    try {
      for (const file of [
        "layout.tsx",
        "feed/page.tsx",
        "feed/default.tsx",
        "feed/@modal/default.tsx",
        "feed/@modal/(.)photos/[id]/page.tsx",
        "feed/@sidebar/page.tsx",
        "feed/@sidebar/default.tsx",
        "photos/[id]/page.tsx",
      ]) {
        fs.mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true });
        fs.writeFileSync(
          path.join(appDir, file),
          "export default function Page() { return null; }\n",
        );
      }
      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const code = generateRscEntry(appDir, routes);

      const feedEntry = code.slice(code.indexOf('pattern: "/feed"'));
      const slotEntry = (slotKey: string) => {
        const start = feedEntry.indexOf(`${JSON.stringify(slotKey)}: {`);
        return feedEntry
          .slice(start, feedEntry.indexOf("\n        ],", start))
          .split("intercepts: [");
      };
      // @modal intercepts, so app/feed/default.tsx replaces its children in
      // the intercepting route's tree. Its loader sits on the intercept, which
      // hydrates only once matched, not with the slot's modules on every /feed
      // request. @sidebar doesn't intercept, so nothing loads it at all.
      const [modalFields, modalIntercepts] = slotEntry("modal@feed/@modal");
      expect(modalFields).not.toContain("__loadOwnerDefault");
      const ownerDefaultLoader = modalIntercepts.match(/__loadOwnerDefault: (\w+),/)?.[1];
      expect(code).toContain(
        `const ${ownerDefaultLoader} = () => import(${JSON.stringify(path.join(appDir, "feed/default.tsx"))});`,
      );
      expect(slotEntry("sidebar@feed/@sidebar").join("")).not.toContain("__loadOwnerDefault");
    } finally {
      invalidateAppRouteCache();
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("generated code carries a slot intercept's layouts above the marker", async () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-intercept-ancestors-"));
    try {
      for (const file of [
        "layout.tsx",
        "gallery/page.tsx",
        "gallery/photo/page.tsx",
        "@modal/default.tsx",
        "@modal/gallery/layout.tsx",
        "@modal/gallery/(.)photo/layout.tsx",
        "@modal/gallery/(.)photo/page.tsx",
      ]) {
        fs.mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true });
        fs.writeFileSync(
          path.join(appDir, file),
          "export default function Page() { return null; }\n",
        );
      }
      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const code = generateRscEntry(appDir, routes);

      // app/@modal/gallery/layout.tsx sits above the (.)photo marker: Next.js's
      // intercepting route tree holds it at the slot's first folder, outside
      // the marker's own layout, so the intercept's layout chain starts with it.
      const galleryEntry = code.slice(code.indexOf('pattern: "/gallery"'));
      const intercept = galleryEntry.slice(galleryEntry.indexOf("interceptLayouts:"));
      expect(intercept).toMatch(/^interceptLayouts: \[null, null\],/);
      expect(intercept).toContain('interceptLayoutSegments: [["gallery"],["gallery","photo"]],');
      const layoutLoaders = intercept.match(/__loadInterceptLayouts: \[(\w+), (\w+)\],/);
      const lazyImports = new Map(
        Array.from(code.matchAll(/^const (\w+) = \(\) => import\(("[^"\n]*")\);$/gm), (match) => [
          match[1],
          JSON.parse(match[2]) as string,
        ]),
      );
      expect(lazyImports.get(layoutLoaders?.[1] ?? "")).toBe(
        toSlash(path.join(appDir, "@modal/gallery/layout.tsx")),
      );
      expect(lazyImports.get(layoutLoaders?.[2] ?? "")).toBe(
        toSlash(path.join(appDir, "@modal/gallery/(.)photo/layout.tsx")),
      );
    } finally {
      invalidateAppRouteCache();
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("generated code carries a sibling intercept's layouts between its source and the marker", async () => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-sibling-intercept-ancestors-"));
    try {
      for (const file of [
        "layout.tsx",
        "feed/page.tsx",
        "photo/page.tsx",
        "feed/(shell)/layout.tsx",
        "feed/(shell)/(.)photo/page.tsx",
      ]) {
        fs.mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true });
        fs.writeFileSync(
          path.join(appDir, file),
          "export default function Page() { return null; }\n",
        );
      }
      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const code = generateRscEntry(appDir, routes);

      // app/feed/(shell)/layout.tsx sits between the source page's folder and
      // the (.)photo marker, so Next.js's intercepting route tree holds it and
      // a force-dynamic export there makes the intercepted response dynamic.
      const feedEntry = code.slice(code.indexOf('pattern: "/feed"'));
      const intercept = feedEntry.slice(feedEntry.indexOf("interceptLayouts:"));
      expect(intercept).toMatch(/^interceptLayouts: \[null\],/);
      expect(intercept).toContain('interceptLayoutSegments: [["(shell)"]],');
      expect(intercept).toContain('interceptBranchSegments: ["(shell)","photo"],');
      const layoutLoader = intercept.match(/__loadInterceptLayouts: \[(\w+)\],/);
      const lazyImports = new Map(
        Array.from(code.matchAll(/^const (\w+) = \(\) => import\(("[^"\n]*")\);$/gm), (match) => [
          match[1],
          JSON.parse(match[2]) as string,
        ]),
      );
      expect(lazyImports.get(layoutLoader?.[1] ?? "")).toBe(
        toSlash(path.join(appDir, "feed/(shell)/layout.tsx")),
      );
    } finally {
      invalidateAppRouteCache();
      fs.rmSync(appDir, { recursive: true, force: true });
    }
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

    expect(code).toMatch(/await import\("[^"]*seed-cache\.js"\)/);
    expect(code).not.toMatch(
      /import \{\s*seedMemoryCacheFromPrerender as __seedMemoryCacheFromPrerender/,
    );
    expect(code).toContain("isrSetPrerenderedAppPage as __isrSetPrerenderedAppPage");
    expect(code).toContain("export async function seedMemoryCacheFromPrerender(serverDir)");
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
