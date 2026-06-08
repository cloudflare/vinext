import {
  computeAppRouteStaticSiblings,
  convertSegmentsToRouteParts,
  type AppRoute,
} from "../routing/app-router.js";
import { createMetadataRouteEntriesSource } from "../server/metadata-route-build-data.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import { normalizePathSeparators } from "../utils/path.js";

type AppRscManifestCode = {
  imports: string[];
  routeEntries: string[];
  metaRouteEntries: string[];
  generateStaticParamsEntries: string[];
  rootParamNameEntries: string[];
  rootNotFoundVar: string | null;
  rootForbiddenVar: string | null;
  rootUnauthorizedVar: string | null;
  rootLayoutVars: string[];
  globalErrorVar: string | null;
  /**
   * Path expression for the `app/global-not-found.{tsx,ts,js,jsx}` module
   * suitable for embedding in a generated `import()` call (already JSON-encoded
   * with platform path separators normalized). `null` when the user did not
   * define `global-not-found.tsx`.
   *
   * We intentionally do NOT register this module as a static `import * as`
   * in the manifest. Statically importing it puts global-not-found.tsx in
   * the same JS chunk as the root layout, which causes the CSS bundler to
   * concatenate their stylesheets into a single CSS file. The CSS minifier
   * (lightningcss) then drops overlapping declarations as dead code, so any
   * rule in global-not-found's CSS that the layout's CSS also defines gets
   * silently removed — breaking the cascade on route-miss 404s where only
   * global-not-found is supposed to render.
   *
   * By emitting a dynamic `import()` instead, the bundler gives
   * global-not-found.tsx its own chunk with its own CSS asset.
   *
   * @see Next.js test: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
   */
  globalNotFoundImportSpecifier: string | null;
};

type BuildAppRscManifestCodeOptions = {
  routes: AppRoute[];
  metadataRoutes?: MetadataFileRoute[];
  globalErrorPath?: string | null;
  /**
   * Optional `app/global-not-found.tsx` path. When present, route-miss 404s
   * render this module standalone (it provides its own <html>/<body>) instead
   * of wrapping the regular not-found boundary inside the root layout.
   * Mirrors Next.js 16's `experimental.globalNotFound` behavior.
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx
   */
  globalNotFoundPath?: string | null;
};

function findRootBoundaryRoute(routes: readonly AppRoute[]): AppRoute | undefined {
  return (
    routes.find((route) => route.pattern === "/") ??
    routes.find((route) => route.layouts.length > 0 && route.layoutTreePositions.length > 0)
  );
}

function rootRouteLayoutPaths(route: AppRoute | undefined): readonly string[] {
  if (!route) return [];
  if (route.pattern === "/") return route.layouts;

  const rootPosition = route.layoutTreePositions[0];
  return route.layouts.filter((_, index) => route.layoutTreePositions[index] === rootPosition);
}

function rootRouteBoundaryPath(
  route: AppRoute | undefined,
  boundaryPaths: readonly (string | null)[] | undefined,
  fallbackPath: string | null | undefined,
): string | null {
  if (!route) return null;
  if (route.pattern === "/") return fallbackPath ?? null;
  // Boundary arrays are ordered from the root layout outward by the route
  // scanner, so the first entry is the root boundary for non-root routes.
  return boundaryPaths?.[0] ?? fallbackPath ?? null;
}

type ImportAllocator = {
  getImportVar(filePath: string): string;
  /**
   * Emit a `const load_N = () => import(path)` lazy loader thunk for a module
   * that should be code-split out of the RSC entry's top-level evaluation
   * (page modules of static routes, and all route-handler modules). Returns the
   * loader variable name. Deduplicated independently of eager imports.
   */
  getLazyLoaderVar(filePath: string): string;
  importMap: ReadonlyMap<string, string>;
  imports: string[];
};

function createImportAllocator(): ImportAllocator {
  const imports: string[] = [];
  const importMap = new Map<string, string>();
  const lazyMap = new Map<string, string>();
  let importIdx = 0;
  let lazyIdx = 0;

  return {
    importMap,
    imports,
    getImportVar(filePath) {
      const existing = importMap.get(filePath);
      if (existing) return existing;

      const varName = `mod_${importIdx++}`;
      const absPath = normalizePathSeparators(filePath);
      imports.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
      importMap.set(filePath, varName);
      return varName;
    },
    getLazyLoaderVar(filePath) {
      const existing = lazyMap.get(filePath);
      if (existing) return existing;

      const varName = `load_${lazyIdx++}`;
      const absPath = normalizePathSeparators(filePath);
      // `filePath` is a trusted filesystem-scan result (route.pagePath /
      // route.routePath), the same input and trust model as the eager
      // `import * as ${var} from ${JSON.stringify(absPath)}` in getImportVar
      // above. CodeQL flags the `import()` form as dynamic code construction,
      // but this is a build-time codegen template with a JSON-encoded absolute
      // path, not runtime-attacker-controlled input — a false positive.
      imports.push(`const ${varName} = () => import(${JSON.stringify(absPath)});`);
      lazyMap.set(filePath, varName);
      return varName;
    },
  };
}

function registerRouteModules(routes: AppRoute[], imports: ImportAllocator): void {
  for (const route of routes) {
    // All page modules are lazy-loaded so route modules — including dynamic
    // routes and routes nested under a dynamic segment — stay out of the RSC
    // entry's top-level evaluation. Their generateStaticParams (if any) is
    // reached via lazy `{ load }` sources in generateStaticParamsMap, resolved
    // on demand at prerender time.
    if (route.pagePath) imports.getLazyLoaderVar(route.pagePath);
    // Route handlers are always lazy: they are never referenced by
    // generateStaticParamsMap (buildGenerateStaticParamsEntries sources only
    // from layouts + page, never route.routePath), so unlike dynamic-route
    // pages they have no module-load-time consumer. (Next.js route handlers can
    // export generateStaticParams for prerendering, but vinext does not wire
    // that into the map yet — a separate gap, unaffected by lazy loading.)
    if (route.routePath) imports.getLazyLoaderVar(route.routePath);
    for (const layout of route.layouts) imports.getImportVar(layout);
    for (const tmpl of route.templates) imports.getImportVar(tmpl);
    if (route.loadingPath) imports.getImportVar(route.loadingPath);
    if (route.errorPath) imports.getImportVar(route.errorPath);
    if (route.layoutErrorPaths) {
      for (const ep of route.layoutErrorPaths) {
        if (ep) imports.getImportVar(ep);
      }
    }
    if (route.errorPaths) {
      for (const ep of route.errorPaths) {
        imports.getImportVar(ep);
      }
    }
    if (route.notFoundPath) imports.getImportVar(route.notFoundPath);
    if (route.notFoundPaths) {
      for (const nfp of route.notFoundPaths) {
        if (nfp) imports.getImportVar(nfp);
      }
    }
    if (route.forbiddenPath) imports.getImportVar(route.forbiddenPath);
    if (route.forbiddenPaths) {
      for (const fp of route.forbiddenPaths) {
        if (fp) imports.getImportVar(fp);
      }
    }
    if (route.unauthorizedPath) imports.getImportVar(route.unauthorizedPath);
    if (route.unauthorizedPaths) {
      for (const up of route.unauthorizedPaths) {
        if (up) imports.getImportVar(up);
      }
    }
    for (const slot of route.parallelSlots) {
      if (slot.pagePath) imports.getImportVar(slot.pagePath);
      if (slot.defaultPath) imports.getImportVar(slot.defaultPath);
      if (slot.layoutPath) imports.getImportVar(slot.layoutPath);
      if (slot.loadingPath) imports.getImportVar(slot.loadingPath);
      if (slot.errorPath) imports.getImportVar(slot.errorPath);
      for (const ir of slot.interceptingRoutes) {
        imports.getLazyLoaderVar(ir.pagePath);
        for (const layoutPath of ir.layoutPaths) {
          imports.getImportVar(layoutPath);
        }
      }
    }
  }
}

function buildRouteEntries(routes: AppRoute[], imports: ImportAllocator): string[] {
  return routes.map((route, routeIdx) => {
    // Pre-compute static-sibling segment names for the matched route's
    // dynamic URL levels. The client router uses this to decide if a cached
    // dynamic-route prefetch can be reused when navigating to a static
    // sibling URL (issue cloudflare/vinext#1525). Emitted only when there are
    // siblings so static routes get an empty literal and stay lean.
    const staticSiblings = route.isDynamic ? computeAppRouteStaticSiblings(routes, route) : [];
    const layoutVars = route.layouts.map((l) => imports.getImportVar(l));
    const templateVars = route.templates.map((t) => imports.getImportVar(t));
    const notFoundVars = (route.notFoundPaths ?? []).map((nf) =>
      nf ? imports.getImportVar(nf) : "null",
    );
    const forbiddenVars = (route.forbiddenPaths ?? []).map((fp) =>
      fp ? imports.getImportVar(fp) : "null",
    );
    const unauthorizedVars = (route.unauthorizedPaths ?? []).map((up) =>
      up ? imports.getImportVar(up) : "null",
    );
    const slotEntries = route.parallelSlots.map((slot) => {
      const interceptEntries = slot.interceptingRoutes.map(
        (ir) => `        {
          convention: ${JSON.stringify(ir.convention)},
          targetPattern: ${JSON.stringify(ir.targetPattern)},
          sourceMatchPattern: ${JSON.stringify(ir.sourceMatchPattern)},
          interceptLayouts: [${ir.layoutPaths.map((layoutPath) => imports.getImportVar(layoutPath)).join(", ")}],
          page: null,
          __pageLoader: ${imports.getLazyLoaderVar(ir.pagePath)},
          params: ${JSON.stringify(ir.params)},
        }`,
      );
      return `      ${JSON.stringify(slot.key)}: {
        id: ${JSON.stringify(slot.id ?? null)},
        name: ${JSON.stringify(slot.name)},
        page: ${slot.pagePath ? imports.getImportVar(slot.pagePath) : "null"},
        default: ${slot.defaultPath ? imports.getImportVar(slot.defaultPath) : "null"},
        layout: ${slot.layoutPath ? imports.getImportVar(slot.layoutPath) : "null"},
        loading: ${slot.loadingPath ? imports.getImportVar(slot.loadingPath) : "null"},
        error: ${slot.errorPath ? imports.getImportVar(slot.errorPath) : "null"},
        layoutIndex: ${slot.layoutIndex},
        routeSegments: ${JSON.stringify(slot.routeSegments)},
        slotPatternParts: ${slot.slotPatternParts ? JSON.stringify(slot.slotPatternParts) : "null"},
        slotParamNames: ${slot.slotParamNames ? JSON.stringify(slot.slotParamNames) : "null"},
        intercepts: [
${interceptEntries.join(",\n")}
        ],
      }`;
    });
    const layoutErrorVars = (route.layoutErrorPaths || []).map((ep) =>
      ep ? imports.getImportVar(ep) : "null",
    );
    const errorVars = (route.errorPaths ?? []).map((ep) => imports.getImportVar(ep));
    // Page and route handler are always lazy-loaded; hydrated onto route.page /
    // route.routeHandler by ensureAppRouteModulesLoaded before any read.
    const loadPageField = route.pagePath ? imports.getLazyLoaderVar(route.pagePath) : "null";
    const loadRouteHandlerField = route.routePath
      ? imports.getLazyLoaderVar(route.routePath)
      : "null";
    return `  {
    __buildTimeClassifications: __VINEXT_CLASS(${routeIdx}), // evaluated once at module load
    __buildTimeReasons: __classDebug ? __VINEXT_CLASS_REASONS(${routeIdx}) : null,
    ids: ${JSON.stringify(route.ids ?? null)},
    pattern: ${JSON.stringify(route.pattern)},
    patternParts: ${JSON.stringify(route.patternParts)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    staticSiblings: ${JSON.stringify(staticSiblings)},
    rootParamNames: ${JSON.stringify(route.rootParamNames ?? [])},
    page: null,
    __loadPage: ${loadPageField},
    routeHandler: null,
    __loadRouteHandler: ${loadRouteHandlerField},
    layouts: [${layoutVars.join(", ")}],
    routeSegments: ${JSON.stringify(route.routeSegments)},
    templateTreePositions: ${JSON.stringify(route.templateTreePositions)},
    layoutTreePositions: ${JSON.stringify(route.layoutTreePositions)},
    templates: [${templateVars.join(", ")}],
    errors: [${layoutErrorVars.join(", ")}],
    errorPaths: [${errorVars.join(", ")}],
    errorTreePositions: ${JSON.stringify(route.errorTreePositions ?? null)},
    slots: {
${slotEntries.join(",\n")}
    },
    loading: ${route.loadingPath ? imports.getImportVar(route.loadingPath) : "null"},
    error: ${route.errorPath ? imports.getImportVar(route.errorPath) : "null"},
    notFound: ${route.notFoundPath ? imports.getImportVar(route.notFoundPath) : "null"},
    notFounds: [${notFoundVars.join(", ")}],
    forbidden: ${route.forbiddenPath ? imports.getImportVar(route.forbiddenPath) : "null"},
    forbiddens: [${forbiddenVars.join(", ")}],
    unauthorized: ${route.unauthorizedPath ? imports.getImportVar(route.unauthorizedPath) : "null"},
    unauthorizeds: [${unauthorizedVars.join(", ")}],
  }`;
  });
}

type RoutePatternPrefix = {
  pattern: string;
  paramNames: string[];
};

function createRoutePatternPrefix(
  routeSegments: readonly string[],
  treePosition: number,
): RoutePatternPrefix | null {
  // treePosition is always non-negative (represents tree depth).
  const limit = Math.min(treePosition, routeSegments.length);
  const converted = convertSegmentsToRouteParts(routeSegments.slice(0, limit));
  if (!converted) return null;

  return {
    pattern: converted.urlSegments.length === 0 ? "/" : `/${converted.urlSegments.join("/")}`,
    paramNames: converted.params,
  };
}

function appendStaticParamSource(
  sourcesByPattern: Map<string, string[]>,
  pattern: string | null,
  sourceVar: string,
): void {
  if (!pattern || pattern === "/" || !pattern.includes(":")) return;
  const sources = sourcesByPattern.get(pattern) ?? [];
  // ImportAllocator is path-stable, so the generated member expression is a
  // deterministic key for deduping the same module across inherited routes.
  if (!sources.includes(sourceVar)) sources.push(sourceVar);
  sourcesByPattern.set(pattern, sources);
}

function buildRootParamNamesByPattern(routes: AppRoute[]): Map<string, string[]> {
  const namesByPattern = new Map<string, string[]>();

  function append(
    pattern: string | null,
    rootParamNames: readonly string[] | undefined,
    paramNames: readonly string[],
  ): void {
    if (!pattern || pattern === "/" || !pattern.includes(":")) return;
    const patternParams = new Set(paramNames);
    const names = (rootParamNames ?? []).filter((name) => patternParams.has(name));
    if (names.length === 0) return;

    const existing = namesByPattern.get(pattern) ?? [];
    for (const name of names) {
      if (!existing.includes(name)) existing.push(name);
    }
    namesByPattern.set(pattern, existing);
  }

  for (const route of routes) {
    if (!route.isDynamic) continue;
    append(route.pattern, route.rootParamNames, route.params);
    for (const treePosition of route.layoutTreePositions) {
      const prefix = createRoutePatternPrefix(route.routeSegments, treePosition);
      append(prefix?.pattern ?? null, route.rootParamNames, prefix?.paramNames ?? []);
    }
  }

  return namesByPattern;
}

function buildGenerateStaticParamsEntries(
  routes: AppRoute[],
  imports: ImportAllocator,
  namesByPattern: Map<string, string[]>,
): string[] {
  const sourcesByPattern = new Map<string, string[]>();

  for (const route of routes) {
    if (!route.isDynamic) continue;

    for (const [index, layoutPath] of route.layouts.entries()) {
      appendStaticParamSource(
        sourcesByPattern,
        createRoutePatternPrefix(route.routeSegments, route.layoutTreePositions[index] ?? 0)
          ?.pattern ?? null,
        `${imports.getImportVar(layoutPath)}?.generateStaticParams`,
      );
    }

    if (route.pagePath) {
      // Page modules are lazy; the resolver imports them on demand at prerender
      // time and reads `.generateStaticParams` then (see
      // createAppPrerenderStaticParamsResolver).
      appendStaticParamSource(
        sourcesByPattern,
        route.pattern,
        `{ load: ${imports.getLazyLoaderVar(route.pagePath)} }`,
      );
    }
  }

  return Array.from(sourcesByPattern.entries()).map(([pattern, sources]) => {
    const rootParamNames = namesByPattern.get(pattern) ?? [];
    return `  ${JSON.stringify(pattern)}: __createAppPrerenderStaticParamsResolver([${sources.join(
      ", ",
    )}], ${JSON.stringify(rootParamNames)}),`;
  });
}

function buildRootParamNameEntries(namesByPattern: Map<string, string[]>): string[] {
  return Array.from(namesByPattern.entries()).map(
    ([pattern, names]) => `  ${JSON.stringify(pattern)}: ${JSON.stringify(names)},`,
  );
}

export function buildAppRscManifestCode(
  options: BuildAppRscManifestCodeOptions,
): AppRscManifestCode {
  const imports = createImportAllocator();
  const metadataRoutes = options.metadataRoutes ?? [];

  registerRouteModules(options.routes, imports);
  const routeEntries = buildRouteEntries(options.routes, imports);

  const rootRoute = findRootBoundaryRoute(options.routes);
  const rootNotFoundPath = rootRouteBoundaryPath(
    rootRoute,
    rootRoute?.notFoundPaths,
    rootRoute?.notFoundPath,
  );
  const rootForbiddenPath = rootRouteBoundaryPath(
    rootRoute,
    rootRoute?.forbiddenPaths,
    rootRoute?.forbiddenPath,
  );
  const rootUnauthorizedPath = rootRouteBoundaryPath(
    rootRoute,
    rootRoute?.unauthorizedPaths,
    rootRoute?.unauthorizedPath,
  );
  const rootNotFoundVar = rootNotFoundPath ? imports.getImportVar(rootNotFoundPath) : null;
  const rootForbiddenVar = rootForbiddenPath ? imports.getImportVar(rootForbiddenPath) : null;
  const rootUnauthorizedVar = rootUnauthorizedPath
    ? imports.getImportVar(rootUnauthorizedPath)
    : null;
  const rootLayoutVars = rootRouteLayoutPaths(rootRoute).map((layoutPath) =>
    imports.getImportVar(layoutPath),
  );
  const globalErrorVar = options.globalErrorPath
    ? imports.getImportVar(options.globalErrorPath)
    : null;
  // Intentionally NOT registered as a static `import * as` — see the docstring
  // on `AppRscManifestCode.globalNotFoundImportSpecifier` for the chunk/CSS
  // isolation rationale. We emit a dynamic `import()` from the entry instead.
  const globalNotFoundImportSpecifier = options.globalNotFoundPath
    ? JSON.stringify(normalizePathSeparators(options.globalNotFoundPath))
    : null;

  const dynamicMetadataRoutes = metadataRoutes.filter((r) => r.isDynamic);
  for (const route of dynamicMetadataRoutes) {
    imports.getImportVar(route.filePath);
  }

  const namesByPattern = buildRootParamNamesByPattern(options.routes);

  return {
    imports: imports.imports,
    routeEntries,
    metaRouteEntries: createMetadataRouteEntriesSource(metadataRoutes, imports.importMap),
    generateStaticParamsEntries: buildGenerateStaticParamsEntries(
      options.routes,
      imports,
      namesByPattern,
    ),
    rootParamNameEntries: buildRootParamNameEntries(namesByPattern),
    rootNotFoundVar,
    rootForbiddenVar,
    rootUnauthorizedVar,
    rootLayoutVars,
    globalErrorVar,
    globalNotFoundImportSpecifier,
  };
}
