import type { AppPageSpecialError } from "./app-page-execution.js";
import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import { getAppPageSegmentParamName } from "./app-page-params.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import { notFoundResponse } from "./http-error-responses.js";
import type { AppLayoutParamAccessTracker } from "./app-layout-param-observation.js";
import { loadAppInterceptLayouts } from "./app-route-module-loader.js";

type AppPageParams = Record<string, string | string[]>;
type GenerateStaticParams = (args: { params: AppPageParams }) => unknown;
type Awaitable<T> = T | Promise<T>;

type GenerateStaticParamsModule = {
  generateStaticParams?: GenerateStaticParams | null;
};

type GenerateStaticParamsSource = {
  /**
   * Primary loader-tree sources execute top-down as one chain. Each source
   * receives the complete params object produced by the sources before it.
   */
  chained?: true;
  generateStaticParams: GenerateStaticParams;
  independentChain?: number;
  paramAliases?: Readonly<Record<string, string>>;
  paramPatternParts?: readonly string[];
  routePatternParts?: readonly string[];
  parentParamNames: readonly string[];
};

type ParallelGenerateStaticParamsBranch = {
  configLayouts?: readonly (GenerateStaticParamsModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  layout?: GenerateStaticParamsModule | null;
  page?: GenerateStaticParamsModule | null;
  paramNames?: readonly string[] | null;
  patternParts?: readonly string[] | null;
  routeSegments?: readonly string[] | null;
};

export type ValidateAppPageDynamicParamsOptions = {
  clearRequestContext: () => void;
  enforceStaticParamsOnly: boolean;
  generateStaticParams?:
    | GenerateStaticParams
    | GenerateStaticParamsSource
    | readonly (GenerateStaticParams | GenerateStaticParamsSource | null | undefined)[]
    | null;
  isDynamicRoute: boolean;
  params: AppPageParams;
};

type ResolveAppPageGenerateStaticParamsSourcesOptions = {
  layouts?: readonly (GenerateStaticParamsModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: GenerateStaticParamsModule | null;
  parallelBranches?: readonly (ParallelGenerateStaticParamsBranch | null | undefined)[];
  routePatternParts?: readonly string[];
  routeSegments: readonly string[];
};

type BuildAppPageElementOptions<TElement> = {
  buildPageElement: () => Promise<TElement>;
  probePageSpecialError?: () => Promise<AppPageSpecialError | null>;
  renderErrorBoundaryPage: (error: unknown) => Promise<Response | null>;
  renderSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
};

type BuildAppPageElementResult<TElement> = {
  element: TElement | null;
  response: Response | null;
};

type AppPageInterceptMatch<TPage = unknown> = {
  interceptLayouts?: readonly unknown[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLoadings?: readonly unknown[] | null;
  interceptLoadingTreePositions?: readonly number[] | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  matchedParams: AppPageParams;
  sourceMatchedParams?: AppPageParams;
  page: TPage;
  __pageLoader?: (() => Promise<TPage>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  __loadState?: {
    page: TPage;
    pageLoading: Promise<TPage> | null;
    notFound?: unknown;
    notFoundLoading?: Promise<unknown> | null;
    interceptLayoutsLoading: Promise<readonly unknown[]> | null;
  };
  slotId?: string | null;
  slotKey: string;
  sourceRouteIndex: number;
  sourcePageSegments?: readonly string[] | null;
};

type ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts> = {
  cleanPathname: string;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => Awaitable<TRoute | undefined>;
  isRscRequest: boolean;
  toInterceptOpts: (intercept: AppPageInterceptMatch<TPage>) => TInterceptOpts;
};

type ResolveAppPageInterceptMatchResult<TRoute, TInterceptOpts> = {
  interceptOpts: TInterceptOpts;
  matchedParams: AppPageParams;
  sourceParams: AppPageParams;
  sourceRoute: TRoute;
};

type AppPageInterceptState<TRoute, TPage> =
  | { kind: "none" }
  | { kind: "current-route"; intercept: AppPageInterceptMatch<TPage> }
  | { kind: "source-route"; intercept: AppPageInterceptMatch<TPage>; sourceRoute: TRoute };

type ResolveAppPageInterceptionRerenderTargetOptions<TRoute, TPage, TInterceptOpts> = {
  cleanPathname: string;
  currentParams: AppPageParams;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => Awaitable<TRoute | undefined>;
  isRscRequest: boolean;
  toInterceptOpts: (intercept: AppPageInterceptMatch<TPage>) => TInterceptOpts;
};

type ResolveAppPageInterceptionRerenderTargetResult<TRoute, TInterceptOpts> = {
  interceptOpts: TInterceptOpts | undefined;
  navigationParams: AppPageParams;
  params: AppPageParams;
  route: TRoute;
};

type ResolveAppPageActionRerenderTargetOptions<TRoute, TPage, TInterceptOpts> =
  ResolveAppPageInterceptionRerenderTargetOptions<TRoute, TPage, TInterceptOpts>;

type ResolveAppPageActionRerenderTargetResult<TRoute, TInterceptOpts> =
  ResolveAppPageInterceptionRerenderTargetResult<TRoute, TInterceptOpts>;

type ResolveAppPageInterceptOptions<TRoute, TPage, TInterceptOpts, TElement> = {
  buildPageElement: (
    route: TRoute,
    params: AppPageParams,
    interceptOpts: TInterceptOpts | undefined,
    searchParams: URLSearchParams,
    layoutParamAccess?: AppLayoutParamAccessTracker,
    buildOptions?: {
      observeMetadataSearchParamsAccess?: boolean;
      observePageSearchParamsAccess?: boolean;
    },
  ) => Promise<TElement>;
  cleanPathname: string;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => Awaitable<TRoute | undefined>;
  isRscRequest: boolean;
  layoutParamAccess?: AppLayoutParamAccessTracker;
  resolveNavigationParams: (
    route: TRoute,
    params: AppPageParams,
    pathname: string,
    interceptOpts: TInterceptOpts,
  ) => AppPageParams;
  renderInterceptResponse: (route: TRoute, element: TElement) => Promise<Response> | Response;
  resolveSearchParams?: (
    route: TRoute,
    searchParams: URLSearchParams,
  ) => Awaitable<URLSearchParams>;
  searchParams: URLSearchParams;
  setNavigationContext: (context: {
    params: AppPageParams;
    pathname: string;
    searchParams: URLSearchParams;
  }) => void;
  toInterceptOpts: (intercept: AppPageInterceptMatch<TPage>) => TInterceptOpts;
};

type ResolveAppPageInterceptResult<TInterceptOpts> = {
  interceptOpts: TInterceptOpts | undefined;
  response: Response | null;
};

function pickRouteParams(
  matchedParams: AppPageParams,
  routeParamNames: readonly string[],
): AppPageParams {
  const params: AppPageParams = {};

  for (const paramName of routeParamNames) {
    const value = matchedParams[paramName];
    if (value !== undefined) {
      params[paramName] = value;
    }
  }

  return params;
}

function remapRouteParams(
  matchedParams: AppPageParams,
  source: Pick<
    GenerateStaticParamsSource,
    "paramAliases" | "paramPatternParts" | "routePatternParts"
  >,
): AppPageParams {
  if (source.paramPatternParts && source.routePatternParts) {
    const urlParts: string[] = [];
    for (const part of source.routePatternParts) {
      if (!part.startsWith(":")) {
        urlParts.push(part);
        continue;
      }

      const paramName = part.slice(1).replace(/[+*]$/, "");
      const value = matchedParams[paramName];
      if (Array.isArray(value)) {
        urlParts.push(...value.map(encodeURIComponent));
      } else if (value !== undefined) {
        urlParts.push(encodeURIComponent(value));
      }
    }

    const slotParams = matchRoutePattern(urlParts, source.paramPatternParts);
    if (slotParams) return slotParams;
  }

  if (!source.paramAliases) return matchedParams;

  const params: AppPageParams = { ...matchedParams };
  for (const [routeParamName, sourceParamName] of Object.entries(source.paramAliases)) {
    const value = matchedParams[routeParamName];
    if (value === undefined) continue;
    delete params[routeParamName];
    params[sourceParamName] = value;
  }
  return params;
}

function collectParentParamNames(
  routeSegments: readonly string[],
  boundaryPosition: number,
): string[] {
  const limit = Math.max(0, Math.min(boundaryPosition, routeSegments.length));
  const names: string[] = [];

  for (const segment of routeSegments.slice(0, limit)) {
    const name = getAppPageSegmentParamName(segment);
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

function getLayoutGenerateStaticParamsBoundary(
  routeSegments: readonly string[],
  layoutTreePosition: number | undefined,
): number {
  // A layout at app/[id]/layout.tsx has tree position 1, but its
  // generateStaticParams belongs to the [id] segment and receives only parent
  // params from segments before [id]. Route groups and parallel slots do not
  // own URL params, so a layout nested immediately inside one still belongs to
  // the preceding visible segment.
  let boundary = Math.min((layoutTreePosition ?? 0) - 1, routeSegments.length - 1);
  while (boundary >= 0) {
    const segment = routeSegments[boundary];
    if (!segment.startsWith("@") && !(segment.startsWith("(") && segment.endsWith(")"))) {
      break;
    }
    boundary -= 1;
  }
  return boundary;
}

function getParallelParentParamNames(
  routeParamNames: readonly string[],
  branch: ParallelGenerateStaticParamsBranch,
  boundaryPosition: number,
): string[] {
  const slotParamNames = branch.paramNames ?? routeParamNames;
  const branchParamNames = collectParentParamNames(branch.routeSegments ?? [], boundaryPosition);
  const branchParamNameSet = new Set(
    (branch.routeSegments ?? []).flatMap((segment) => {
      const name = getAppPageSegmentParamName(segment);
      return name ? [name] : [];
    }),
  );
  const ownerParamNames = slotParamNames.filter((name) => !branchParamNameSet.has(name));
  return [...new Set([...ownerParamNames, ...branchParamNames])];
}

export function resolveAppPageGenerateStaticParamsSources(
  options: ResolveAppPageGenerateStaticParamsSourcesOptions,
): GenerateStaticParamsSource[] {
  const sources: GenerateStaticParamsSource[] = [];

  options.layouts?.forEach((layout, index) => {
    if (typeof layout?.generateStaticParams !== "function") return;

    sources.push({
      chained: true,
      generateStaticParams: layout.generateStaticParams,
      parentParamNames: collectParentParamNames(
        options.routeSegments,
        getLayoutGenerateStaticParamsBoundary(
          options.routeSegments,
          options.layoutTreePositions?.[index],
        ),
      ),
    });
  });

  if (typeof options.page?.generateStaticParams === "function") {
    sources.push({
      chained: true,
      generateStaticParams: options.page.generateStaticParams,
      parentParamNames: collectParentParamNames(
        options.routeSegments,
        Math.max(0, options.routeSegments.length - 1),
      ),
    });
  }

  const routeParamNames = options.routeSegments.flatMap((segment) => {
    const name = getAppPageSegmentParamName(segment);
    return name ? [name] : [];
  });
  for (const [independentChain, parallelBranch] of (options.parallelBranches ?? []).entries()) {
    if (!parallelBranch) continue;
    const slotParamNames = parallelBranch.paramNames ?? routeParamNames;
    const paramAliases = Object.fromEntries(
      routeParamNames.flatMap((routeParamName, index) => {
        const slotParamName = slotParamNames[index];
        return slotParamName && slotParamName !== routeParamName
          ? [[routeParamName, slotParamName]]
          : [];
      }),
    );
    const addParallelSource = (
      module: GenerateStaticParamsModule | null | undefined,
      boundaryPosition: number,
    ) => {
      if (typeof module?.generateStaticParams !== "function") return;
      sources.push({
        generateStaticParams: module.generateStaticParams,
        independentChain,
        ...(Object.keys(paramAliases).length > 0 ? { paramAliases } : {}),
        ...(parallelBranch.patternParts ? { paramPatternParts: parallelBranch.patternParts } : {}),
        ...(options.routePatternParts ? { routePatternParts: options.routePatternParts } : {}),
        parentParamNames: getParallelParentParamNames(
          routeParamNames,
          parallelBranch,
          boundaryPosition,
        ),
      });
    };

    addParallelSource(parallelBranch.layout, -1);
    parallelBranch.configLayouts?.forEach((layout, index) => {
      addParallelSource(
        layout,
        getLayoutGenerateStaticParamsBoundary(
          parallelBranch.routeSegments ?? [],
          parallelBranch.configLayoutTreePositions?.[index],
        ),
      );
    });
    addParallelSource(
      parallelBranch.page,
      Math.max(0, (parallelBranch.routeSegments?.length ?? 0) - 1),
    );
  }

  return sources;
}

function areStaticParamsAllowed(
  params: AppPageParams,
  staticParams: readonly Record<string, unknown>[],
  allowMissingValues = false,
): boolean {
  const paramKeys = Object.keys(params);
  // Next.js compares the concrete request pathname against generated encoded
  // pathnames exactly. This generated-path gate is case-sensitive even though
  // custom redirect, rewrite, and header sources are case-insensitive by default.
  const stringParamMatches = (value: string, staticValue: string): boolean =>
    value === encodeURIComponent(staticValue);

  return staticParams.some((staticParamSet) =>
    paramKeys.every((key) => {
      const value = params[key];
      const staticValue = staticParamSet[key];

      if (!Object.hasOwn(staticParamSet, key)) {
        return allowMissingValues;
      }

      if (Array.isArray(value)) {
        return (
          Array.isArray(staticValue) &&
          value.length === staticValue.length &&
          value.every((part, index) =>
            typeof staticValue[index] === "string"
              ? stringParamMatches(part, staticValue[index])
              : part === staticValue[index],
          )
        );
      }

      if (typeof staticValue === "string") {
        return stringParamMatches(value, staticValue);
      }

      if (typeof staticValue === "number" || typeof staticValue === "boolean") {
        return String(value) === String(staticValue);
      }

      return JSON.stringify(value) === JSON.stringify(staticValue);
    }),
  );
}

function remapStaticParamsToRouteParams(
  staticParams: readonly Record<string, unknown>[],
  source: GenerateStaticParamsSource,
): Record<string, unknown>[] {
  if (!source.paramAliases) return [...staticParams];

  const routeParamNamesBySourceName = new Map(
    Object.entries(source.paramAliases).map(([routeParamName, sourceParamName]) => [
      sourceParamName,
      routeParamName,
    ]),
  );
  return staticParams.map((params) =>
    Object.fromEntries(
      Object.entries(params).map(([name, value]) => [
        routeParamNamesBySourceName.get(name) ?? name,
        value,
      ]),
    ),
  );
}

async function generateIndependentStaticParams(
  sources: readonly GenerateStaticParamsSource[],
  primaryParams: readonly Record<string, unknown>[] | null,
  requestParams: AppPageParams,
): Promise<{ staticParams: Record<string, unknown>[]; validated: boolean }> {
  let rows = (primaryParams ?? []).map((params) => ({ params, branchParams: {} }));
  let hasParentParams = rows.length > 0;
  let validated = false;

  for (const source of sources) {
    const parents = hasParentParams ? rows : [{ params: {}, branchParams: {} }];
    const nextRows: typeof rows = [];

    for (const parent of parents) {
      const sourceParams = remapRouteParams(
        { ...requestParams, ...parent.params } as AppPageParams,
        source,
      );
      const branchParams = remapRouteParams(parent.branchParams as AppPageParams, source);
      const result = await runWithFetchDedupe(() =>
        source.generateStaticParams({
          params: {
            ...pickRouteParams(sourceParams, source.parentParamNames),
            ...branchParams,
          },
        }),
      );
      if (!Array.isArray(result)) {
        if (hasParentParams) nextRows.push(parent);
        continue;
      }

      validated = true;
      const routeResults = remapStaticParamsToRouteParams(result, source);
      if (routeResults.length === 0) {
        if (hasParentParams) nextRows.push(parent);
        continue;
      }
      for (const routeResult of routeResults) {
        nextRows.push({
          params: { ...parent.params, ...routeResult },
          branchParams: { ...parent.branchParams, ...routeResult },
        });
      }
    }

    rows = nextRows;
    hasParentParams = rows.length > 0;
  }

  return { staticParams: rows.map((row) => row.params), validated };
}

async function generateChainedStaticParams(
  sources: readonly GenerateStaticParamsSource[],
): Promise<Record<string, unknown>[]> {
  let generatedParams: Record<string, unknown>[] = [];

  for (const source of sources) {
    const hasParentParams = generatedParams.length > 0;
    const parents = hasParentParams ? generatedParams : [{}];
    const nextParams: Record<string, unknown>[] = [];

    for (const parentParams of parents) {
      const result = await runWithFetchDedupe(() =>
        source.generateStaticParams({ params: parentParams as AppPageParams }),
      );
      if (Array.isArray(result) && result.length > 0) {
        for (const item of result) {
          if (item !== null && typeof item === "object" && !Array.isArray(item)) {
            nextParams.push({ ...parentParams, ...(item as Record<string, unknown>) });
          }
        }
      } else if (hasParentParams) {
        // Match Next's non-PPR generation: an empty child result preserves
        // each already-generated parent combination.
        nextParams.push(parentParams);
      }
    }

    generatedParams = nextParams;
  }

  return generatedParams;
}

function normalizeGenerateStaticParams(
  generateStaticParams: ValidateAppPageDynamicParamsOptions["generateStaticParams"],
): GenerateStaticParamsSource[] {
  const sources = Array.isArray(generateStaticParams)
    ? generateStaticParams
    : [generateStaticParams];

  return sources.flatMap((source) => {
    if (typeof source === "function") {
      return [{ generateStaticParams: source, parentParamNames: [] }];
    }

    if (typeof source?.generateStaticParams === "function") {
      return [source];
    }

    return [];
  });
}

export async function validateAppPageDynamicParams(
  options: ValidateAppPageDynamicParamsOptions,
): Promise<Response | null> {
  if (!options.enforceStaticParamsOnly || !options.isDynamicRoute) {
    return null;
  }

  const generateStaticParamsSources = normalizeGenerateStaticParams(options.generateStaticParams);
  if (generateStaticParamsSources.length === 0) {
    options.clearRequestContext();
    return notFoundResponse();
  }

  const chainedSources = generateStaticParamsSources.filter((source) => source.chained);
  let chainedStaticParams: Record<string, unknown>[] | null = null;
  if (chainedSources.length > 0) {
    // Next walks the loader-tree segments top-down. Route groups are real
    // loader-tree segments even though they do not appear in the URL, so a
    // generateStaticParams exported by a grouped layout receives everything
    // generated by its parent layouts.
    // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
    chainedStaticParams = await generateChainedStaticParams(chainedSources);
  }

  const independentChains = new Map<unknown, GenerateStaticParamsSource[]>();
  for (const source of generateStaticParamsSources.filter((source) => !source.chained)) {
    const chain = independentChains.get(source.independentChain ?? source) ?? [];
    chain.push(source);
    independentChains.set(source.independentChain ?? source, chain);
  }

  let validatedIndependentResults = false;
  for (const sources of independentChains.values()) {
    const result = await generateIndependentStaticParams(
      sources,
      chainedStaticParams,
      options.params,
    );
    if (result.validated) {
      validatedIndependentResults = true;
      if (!areStaticParamsAllowed(options.params, result.staticParams, true)) {
        options.clearRequestContext();
        return notFoundResponse();
      }
    }
  }

  if (chainedStaticParams && !validatedIndependentResults) {
    // Next merges each generated result into its parent combination. Parallel
    // results are validated against those combinations above; without a
    // parallel result, the primary chain itself must match exactly.
    // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
    if (!areStaticParamsAllowed(options.params, chainedStaticParams)) {
      options.clearRequestContext();
      return notFoundResponse();
    }
  }

  return null;
}

/**
 * Pure: decides whether the incoming request should re-render an intercepted
 * source-route tree, and if so returns the source route, the source-route's
 * param slice, the full matched param set (the URL params the client sees),
 * and an opaque `interceptOpts` bag for the caller's render pipeline.
 *
 * Returns `null` in three decision-fallthrough cases:
 *   - non-RSC requests (server rendering the direct page for a full HTML load)
 *   - no intercepting route matches the path
 *   - the match's source route IS the current route (the same branch today
 *     returns `interceptOpts` for the direct render)
 *
 * Shared by both the GET path (resolveAppPageIntercept, which layers on
 * `setNavigationContext` + element build + Response wrap) and the server-action
 * POST path (entries/app-rsc-entry.ts), which runs its own response pipeline.
 */
export async function resolveAppPageInterceptMatch<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts>,
): Promise<ResolveAppPageInterceptMatchResult<TRoute, TInterceptOpts> | null> {
  const interceptState = await resolveAppPageInterceptState(options);
  if (interceptState.kind !== "source-route") {
    return null;
  }

  return {
    interceptOpts: options.toInterceptOpts(interceptState.intercept),
    matchedParams: interceptState.intercept.matchedParams,
    sourceParams: pickRouteParams(
      interceptState.intercept.sourceMatchedParams ?? interceptState.intercept.matchedParams,
      options.getRouteParamNames(interceptState.sourceRoute),
    ),
    sourceRoute: interceptState.sourceRoute,
  };
}

async function resolveAppPageInterceptState<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts>,
): Promise<AppPageInterceptState<TRoute, TPage>> {
  if (!options.isRscRequest) {
    return { kind: "none" };
  }

  const intercept = options.findIntercept(options.cleanPathname);
  if (!intercept) {
    return { kind: "none" };
  }

  const loadState = intercept.__loadState;
  if (loadState?.page != null) intercept.page = loadState.page;
  if (intercept.__pageLoader && intercept.page == null) {
    const loading =
      loadState?.pageLoading ??
      intercept
        .__pageLoader()
        .then((page) => {
          intercept.page = page;
          if (loadState) {
            loadState.page = page;
            loadState.pageLoading = null;
          }
          return page;
        })
        .catch((error: unknown) => {
          if (loadState) loadState.pageLoading = null;
          throw error;
        });
    if (loadState) loadState.pageLoading = loading;
    await loading;
  }
  if (loadState?.notFound != null) intercept.notFound = loadState.notFound;
  if (intercept.__loadNotFound && intercept.notFound == null) {
    const loading =
      loadState?.notFoundLoading ??
      intercept
        .__loadNotFound()
        .then((notFound) => {
          intercept.notFound = notFound;
          if (loadState) {
            loadState.notFound = notFound;
            loadState.notFoundLoading = null;
          }
          return notFound;
        })
        .catch((error: unknown) => {
          if (loadState) loadState.notFoundLoading = null;
          throw error;
        });
    if (loadState) loadState.notFoundLoading = loading;
    await loading;
  }
  if (intercept.__loadInterceptLayouts || intercept.__loadInterceptLoadings) {
    await loadAppInterceptLayouts(intercept);
  }

  const sourceRoute = await options.getSourceRoute(intercept.sourceRouteIndex);
  if (!sourceRoute) {
    return { kind: "none" };
  }

  if (sourceRoute === options.currentRoute) {
    return { kind: "current-route", intercept };
  }

  return { kind: "source-route", intercept, sourceRoute };
}

export async function resolveAppPageInterceptionRerenderTarget<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptionRerenderTargetOptions<TRoute, TPage, TInterceptOpts>,
): Promise<ResolveAppPageInterceptionRerenderTargetResult<TRoute, TInterceptOpts>> {
  const interceptState = await resolveAppPageInterceptState({
    cleanPathname: options.cleanPathname,
    currentRoute: options.currentRoute,
    findIntercept: options.findIntercept,
    getRouteParamNames: options.getRouteParamNames,
    getSourceRoute: options.getSourceRoute,
    isRscRequest: options.isRscRequest,
    toInterceptOpts: options.toInterceptOpts,
  });

  if (interceptState.kind === "source-route") {
    const sourceMatchedParams =
      interceptState.intercept.sourceMatchedParams ?? interceptState.intercept.matchedParams;
    return {
      interceptOpts: options.toInterceptOpts(interceptState.intercept),
      navigationParams: {
        ...sourceMatchedParams,
        ...interceptState.intercept.matchedParams,
      },
      params: pickRouteParams(
        sourceMatchedParams,
        options.getRouteParamNames(interceptState.sourceRoute),
      ),
      route: interceptState.sourceRoute,
    };
  }

  return {
    interceptOpts:
      interceptState.kind === "current-route"
        ? options.toInterceptOpts(interceptState.intercept)
        : undefined,
    navigationParams: options.currentParams,
    params: options.currentParams,
    route: options.currentRoute,
  };
}

export function resolveAppPageActionRerenderTarget<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageActionRerenderTargetOptions<TRoute, TPage, TInterceptOpts>,
): Promise<ResolveAppPageActionRerenderTargetResult<TRoute, TInterceptOpts>> {
  return resolveAppPageInterceptionRerenderTarget(options);
}

export async function resolveAppPageIntercept<TRoute, TPage, TInterceptOpts, TElement>(
  options: ResolveAppPageInterceptOptions<TRoute, TPage, TInterceptOpts, TElement>,
): Promise<ResolveAppPageInterceptResult<TInterceptOpts>> {
  const interceptState = await resolveAppPageInterceptState({
    cleanPathname: options.cleanPathname,
    currentRoute: options.currentRoute,
    findIntercept: options.findIntercept,
    getRouteParamNames: options.getRouteParamNames,
    getSourceRoute: options.getSourceRoute,
    isRscRequest: options.isRscRequest,
    toInterceptOpts: options.toInterceptOpts,
  });

  if (interceptState.kind === "source-route") {
    const renderRoute = interceptState.sourceRoute;
    const interceptOpts = options.toInterceptOpts(interceptState.intercept);
    const sourceMatchedParams =
      interceptState.intercept.sourceMatchedParams ?? interceptState.intercept.matchedParams;
    const navigationParams = {
      ...sourceMatchedParams,
      ...interceptState.intercept.matchedParams,
    };
    const renderSearchParams = options.resolveSearchParams
      ? await options.resolveSearchParams(renderRoute, options.searchParams)
      : options.searchParams;
    const renderParams = pickRouteParams(
      sourceMatchedParams,
      options.getRouteParamNames(interceptState.sourceRoute),
    );

    options.setNavigationContext({
      params: options.resolveNavigationParams(
        renderRoute,
        navigationParams,
        options.cleanPathname,
        interceptOpts,
      ),
      pathname: options.cleanPathname,
      searchParams: renderSearchParams,
    });
    const interceptElement = await options.buildPageElement(
      renderRoute,
      renderParams,
      interceptOpts,
      renderSearchParams,
      options.layoutParamAccess,
    );

    return {
      interceptOpts: undefined,
      response: await options.renderInterceptResponse(renderRoute, interceptElement),
    };
  }

  // Reproduce the current-route-is-source branch where we still need the opts
  // bag even though we did not render a separate intercepted response.
  return {
    interceptOpts:
      interceptState.kind === "current-route"
        ? options.toInterceptOpts(interceptState.intercept)
        : undefined,
    response: null,
  };
}

export async function buildAppPageElement<TElement>(
  options: BuildAppPageElementOptions<TElement>,
): Promise<BuildAppPageElementResult<TElement>> {
  try {
    return {
      element: await options.buildPageElement(),
      response: null,
    };
  } catch (error) {
    const buildSpecialError = options.resolveSpecialError(error);
    const pageSpecialError = buildSpecialError ? await options.probePageSpecialError?.() : null;
    const specialError = pageSpecialError ?? buildSpecialError;
    if (specialError) {
      return {
        element: null,
        response: await options.renderSpecialError(specialError),
      };
    }

    const errorBoundaryResponse = await options.renderErrorBoundaryPage(error);
    if (errorBoundaryResponse) {
      return {
        element: null,
        response: errorBoundaryResponse,
      };
    }

    throw error;
  }
}
