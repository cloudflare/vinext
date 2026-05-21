import { convertSegmentsToRouteParts, type AppRoute } from "../routing/app-router.js";
import { collectAppRouteModuleFiles } from "../server/app-route-module-files.js";
import { createMetadataRouteEntriesSource } from "../server/metadata-route-build-data.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import { normalizePathSeparators } from "./runtime-entry-module.js";

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
  globalNotFoundVar: string | null;
};

type BuildAppRscManifestCodeOptions = {
  routes: AppRoute[];
  metadataRoutes?: MetadataFileRoute[];
  globalErrorPath?: string | null;
  devCssStylesByRoute?: readonly (readonly string[])[];
  /**
   * Optional `app/global-not-found.tsx` path. When present, route-miss 404s
   * render this module standalone (it provides its own <html>/<body>) instead
   * of wrapping the regular not-found boundary inside the root layout.
   * Mirrors Next.js 16's `experimental.globalNotFound` behavior.
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx
   */
  globalNotFoundPath?: string | null;
};

type ImportAllocator = {
  getImportVar(filePath: string): string;
  importMap: ReadonlyMap<string, string>;
  imports: string[];
};

function createImportAllocator(): ImportAllocator {
  const imports: string[] = [];
  const importMap = new Map<string, string>();
  let importIdx = 0;

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
  };
}

function registerRouteModules(routes: AppRoute[], imports: ImportAllocator): void {
  for (const route of routes) {
    for (const filePath of collectAppRouteModuleFiles(route, { includeRouteHandler: true })) {
      imports.getImportVar(filePath);
    }
  }
}

function buildRouteEntry(
  route: AppRoute,
  routeIdx: number,
  imports: ImportAllocator,
  styles: readonly string[],
): string {
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
          page: ${imports.getImportVar(ir.pagePath)},
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
  return `  {
    __buildTimeClassifications: __VINEXT_CLASS(${routeIdx}), // evaluated once at module load
    __buildTimeReasons: __classDebug ? __VINEXT_CLASS_REASONS(${routeIdx}) : null,
    ids: ${JSON.stringify(route.ids ?? null)},
    pattern: ${JSON.stringify(route.pattern)},
    patternParts: ${JSON.stringify(route.patternParts)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    rootParamNames: ${JSON.stringify(route.rootParamNames ?? [])},
    page: ${route.pagePath ? imports.getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? imports.getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
${styles.length > 0 ? `    styles: ${JSON.stringify(styles)},\n` : ""}    routeSegments: ${JSON.stringify(route.routeSegments)},
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
}

function buildRouteEntries(
  routes: AppRoute[],
  imports: ImportAllocator,
  stylesByRoute: readonly (readonly string[])[],
): string[] {
  return routes.map((route, routeIdx) =>
    buildRouteEntry(route, routeIdx, imports, stylesByRoute[routeIdx] ?? []),
  );
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
      appendStaticParamSource(
        sourcesByPattern,
        route.pattern,
        `${imports.getImportVar(route.pagePath)}?.generateStaticParams`,
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

function completeAppRscManifestCode(
  options: BuildAppRscManifestCodeOptions,
  imports: ImportAllocator,
  routeEntries: string[],
): AppRscManifestCode {
  const metadataRoutes = options.metadataRoutes ?? [];

  const rootRoute = options.routes.find((r) => r.pattern === "/");
  const rootNotFoundVar = rootRoute?.notFoundPath
    ? imports.getImportVar(rootRoute.notFoundPath)
    : null;
  const rootForbiddenVar = rootRoute?.forbiddenPath
    ? imports.getImportVar(rootRoute.forbiddenPath)
    : null;
  const rootUnauthorizedVar = rootRoute?.unauthorizedPath
    ? imports.getImportVar(rootRoute.unauthorizedPath)
    : null;
  const rootLayoutVars = rootRoute ? rootRoute.layouts.map((l) => imports.getImportVar(l)) : [];
  const globalErrorVar = options.globalErrorPath
    ? imports.getImportVar(options.globalErrorPath)
    : null;
  const globalNotFoundVar = options.globalNotFoundPath
    ? imports.getImportVar(options.globalNotFoundPath)
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
    globalNotFoundVar,
  };
}

export function buildAppRscManifestCode(
  options: BuildAppRscManifestCodeOptions,
): AppRscManifestCode {
  const imports = createImportAllocator();

  registerRouteModules(options.routes, imports);
  return completeAppRscManifestCode(
    options,
    imports,
    buildRouteEntries(options.routes, imports, options.devCssStylesByRoute ?? []),
  );
}
