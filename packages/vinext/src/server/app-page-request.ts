import type { AppPageSpecialError } from "./app-page-execution.js";
import {
  runWithFetchDedupe,
  setCurrentFetchCacheMode,
  setCurrentFetchRevalidate,
  setCurrentFetchSoftTags,
  setCurrentForceDynamicFetchDefault,
  type FetchCacheMode,
} from "vinext/shims/fetch-cache";
import { buildAppStaticParamsTags } from "./implicit-tags.js";
import { getAppPageSegmentParamName } from "./app-page-params.js";
import {
  interceptionMarkerPatternParam,
  matchRoutePattern,
  withoutInterceptionMarker,
} from "../routing/route-pattern.js";
import { patternToNextFormat } from "../routing/route-validation.js";
import { notFoundResponse } from "./http-error-responses.js";
import { removeTrailingSlash } from "../utils/base-path.js";
import { getRenderedConcreteUrlPathsForRoute } from "./pregenerated-concrete-paths.js";
import {
  pickRootParams,
  runGenerateStaticParamsWithRootParams,
  type RootParams,
} from "vinext/shims/root-params";
import { isUnknownRecord } from "../utils/record.js";
import { isRouteSegmentFetchCache } from "./app-segment-config.js";
import {
  loadAppInterceptLayouts,
  loadAppInterceptNotFound,
  loadAppInterceptOwnerDefault,
  loadAppInterceptPage,
} from "./app-route-module-loader.js";

type AppPageParams = Record<string, string | string[]>;
type GenerateStaticParams = (args: { params: AppPageParams }) => unknown;
type Awaitable<T> = T | Promise<T>;

type GenerateStaticParamsModule = {
  fetchCache?: unknown;
  generateStaticParams?: GenerateStaticParams | null;
};

export type GenerateStaticParamsSource = {
  /**
   * Primary loader-tree sources execute top-down as one chain. Each source
   * receives the complete params object produced by the sources before it.
   */
  chained?: true;
  /** The `fetchCache` of the segment that exports the generator. */
  fetchCache?: FetchCacheMode;
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
  enforceStaticParamsOnly: boolean;
  generateStaticParams?:
    | GenerateStaticParams
    | GenerateStaticParamsSource
    | readonly (GenerateStaticParams | GenerateStaticParamsSource | null | undefined)[]
    | null;
  isDynamicRoute: boolean;
  optionalCatchAllParamNames?: readonly string[];
  params: AppPageParams;
  /**
   * Enforce only when the request's parent params generate a row and every
   * such row has each of these params, as Next.js prerenders a route whose
   * last dynamic segment has no generator only when every row does. Otherwise
   * any params render.
   */
  enforceWhenEveryParamGenerated?: readonly string[];
  requiredParamNames?: readonly string[];
  /**
   * The route's root param names. Each generator call then reads its parent
   * params as its root params, as in Next.js's generator walk.
   */
  rootParamNames?: readonly string[];
  /** The route's pattern, named in root param errors. */
  routePattern?: string;
  /** The fetchCache the generators start from, when the caller sets one. */
  initialFetchCache?: FetchCacheMode | null;
  /**
   * With `enforceWhenEveryParamGenerated`, a match among the rows for the
   * request's parent params also runs the generators for every other parent,
   * to report whether every row has every param (`generatesEveryParam`).
   */
  confirmEveryParamGenerated?: boolean;
};

/** The outcome of a `dynamicParams = false` check. */
export type AppPageDynamicParamsCheck = {
  /** The 404 for params the route doesn't list, or `null` to render. */
  response: Response | null;
  /**
   * Whether every row the generators give has every param and the request is
   * one of them, so Next.js prerenders the request's path. Reported only for
   * `confirmEveryParamGenerated`.
   */
  generatesEveryParam: boolean;
};

const renderCheck: AppPageDynamicParamsCheck = Object.freeze({
  response: null,
  generatesEveryParam: false,
});

function notFoundCheck(): AppPageDynamicParamsCheck {
  return { response: notFoundResponse(), generatesEveryParam: false };
}

type ResolveAppPageGenerateStaticParamsSourcesOptions = {
  /**
   * Gives each source its segment's `fetchCache`. Only a chain in Next.js's
   * breadth-first order can apply them per generator: a route runs its
   * parallel chains after its children's, so it keeps its tree-wide mode.
   */
  fetchCachePerSource?: boolean;
  layouts?: readonly (GenerateStaticParamsModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: GenerateStaticParamsModule | null;
  parallelBranches?: readonly (ParallelGenerateStaticParamsBranch | null | undefined)[];
  routePatternParts?: readonly string[];
  routeSegments: readonly string[];
};

type BuildAppPageElementOptions<TElement> = {
  buildPageElement: () => Promise<TElement>;
  renderErrorBoundaryPage: (error: unknown) => Promise<Response | null>;
  renderSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
};

type BuildAppPageElementResult<TElement> = {
  element: TElement | null;
  response: Response | null;
};

type AppPageInterceptMatch<TPage = unknown> = {
  interceptionId?: string | null;
  interceptionGraphId?: string | null;
  interceptLayouts?: readonly unknown[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLoadings?: readonly unknown[] | null;
  interceptLoadingTreePositions?: readonly number[] | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  interceptNotFounds?: readonly unknown[] | null;
  interceptNotFoundTreePositions?: readonly number[] | null;
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptNotFounds?: readonly (() => Promise<unknown>)[] | null;
  matchedParams: AppPageParams;
  sourceMatchedParams?: AppPageParams;
  page: TPage;
  __pageLoader?: (() => Promise<TPage>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[] | null;
  interceptForbiddenTreePositions?: readonly number[] | null;
  __loadInterceptForbiddens?: readonly (() => Promise<unknown>)[] | null;
  interceptUnauthorizeds?: readonly unknown[] | null;
  interceptUnauthorizedTreePositions?: readonly number[] | null;
  __loadInterceptUnauthorizeds?: readonly (() => Promise<unknown>)[] | null;
  interceptErrors?: readonly unknown[] | null;
  interceptErrorTreePositions?: readonly number[] | null;
  __loadInterceptErrors?: readonly (() => Promise<unknown>)[] | null;
  ownerDefault?: unknown;
  __loadOwnerDefault?: (() => Promise<unknown>) | null;
  __loadState?: {
    page: TPage;
    pageLoading: Promise<TPage> | null;
    notFound?: unknown;
    notFoundLoading?: Promise<unknown> | null;
    ownerDefault?: unknown;
    ownerDefaultLoading?: Promise<unknown> | null;
    interceptLayoutsLoading: Promise<readonly unknown[]> | null;
  };
  /**
   * The source shares none of the intercepting route's tree, so the render is
   * of that tree whole (see app-rsc-route-matching.ts).
   */
  rendersWholeInterceptingRoute?: boolean;
  slotId?: string | null;
  slotKey: string;
  sourceRouteIndex: number;
  sourcePageSegments?: readonly string[] | null;
  /** False when the source URL resolved to no route of its own. */
  sourceRouteIsConcrete?: boolean;
  targetPatternParts?: readonly string[];
  targetRouteGraphId?: string | null;
};

export type AppPageInterceptState<TRoute, TPage> =
  | { kind: "none" }
  | { kind: "current-route"; intercept: AppPageInterceptMatch<TPage> }
  | { kind: "source-route"; intercept: AppPageInterceptMatch<TPage>; sourceRoute: TRoute };

type AppPageInterceptStateLookup<TRoute, TPage> = {
  cleanPathname: string;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getSourceRoute: (sourceRouteIndex: number) => Awaitable<TRoute | undefined>;
  /** The state this request already resolved, which is then reused. */
  interceptState?: AppPageInterceptState<TRoute, TPage>;
  isRscRequest: boolean;
};

type ResolveAppPageInterceptionRerenderTargetOptions<TRoute, TPage, TInterceptOpts> = {
  cleanPathname: string;
  currentParams: AppPageParams;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => Awaitable<TRoute | undefined>;
  interceptState?: AppPageInterceptState<TRoute, TPage>;
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
  interceptState?: AppPageInterceptState<TRoute, TPage>;
  isRscRequest: boolean;
  resolveNavigationParams: (
    route: TRoute,
    params: AppPageParams,
    pathname: string,
    interceptOpts: TInterceptOpts,
  ) => AppPageParams;
  renderInterceptResponse: (
    route: TRoute,
    element: TElement,
    navigationParams: AppPageParams,
  ) => Promise<Response> | Response;
  resolveSearchParams?: (
    route: TRoute,
    searchParams: URLSearchParams,
    interceptOpts: TInterceptOpts,
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
  /** The params a current-route interception renders with, when it differs. */
  navigationParams?: AppPageParams;
  params?: AppPageParams;
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
  const segmentFetchCache = (module: GenerateStaticParamsModule): { fetchCache?: FetchCacheMode } =>
    options.fetchCachePerSource && isRouteSegmentFetchCache(module.fetchCache)
      ? { fetchCache: module.fetchCache }
      : {};

  options.layouts?.forEach((layout, index) => {
    if (typeof layout?.generateStaticParams !== "function") return;

    sources.push({
      chained: true,
      ...segmentFetchCache(layout),
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
      ...segmentFetchCache(options.page),
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
        ...segmentFetchCache(module),
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
  paramKeys: readonly string[] = Object.keys(params),
  optionalCatchAllParamNames: readonly string[] = [],
): boolean {
  // Next.js compares the concrete request pathname against generated encoded
  // pathnames exactly. This generated-path gate is case-sensitive even though
  // custom redirect, rewrite, and header sources are case-insensitive by default.
  const stringParamMatches = (value: string, staticValue: string): boolean =>
    value === encodeURIComponent(staticValue);

  return staticParams.some((staticParamSet) => {
    if (!staticParamSet || typeof staticParamSet !== "object" || Array.isArray(staticParamSet)) {
      return false;
    }
    return paramKeys.every((key) => {
      const value = params[key];
      const staticValue = staticParamSet[key];

      if (!Object.hasOwn(staticParamSet, key)) {
        return allowMissingValues;
      }

      if (value === undefined) {
        return (
          optionalCatchAllParamNames.includes(key) &&
          (staticValue === undefined ||
            staticValue === null ||
            staticValue === false ||
            (Array.isArray(staticValue) && staticValue.length === 0))
        );
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
    });
  });
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

/** A route's root param names, and the route its generator errors name. */
type GeneratorRootParams = { names: readonly string[]; route: string } | undefined;

// Next.js runs each generateStaticParams with its parent params as the root
// params, whatever the request's are.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
function callGenerateStaticParams(
  source: GenerateStaticParamsSource,
  params: AppPageParams,
  parentParams: Record<string, unknown>,
  rootParams: GeneratorRootParams,
): Promise<unknown> {
  const call = async () => runWithFetchDedupe(() => source.generateStaticParams({ params }));
  if (!rootParams) return call();
  return runGenerateStaticParamsWithRootParams(
    rootParams.route,
    parentParams as RootParams,
    rootParams.names,
    call,
  );
}

async function generateIndependentStaticParams(
  sources: readonly GenerateStaticParamsSource[],
  primaryParams: readonly Record<string, unknown>[] | null,
  requestParams: AppPageParams,
  rootParams: GeneratorRootParams,
): Promise<{ staticParams: Record<string, unknown>[]; validated: boolean }> {
  let rows = (primaryParams ?? []).map((params) => ({ params, branchParams: {} }));
  let hasParentParams = rows.length > 0;
  let validated = false;

  for (const source of sources) {
    applySourceFetchCache(source);
    const parents = hasParentParams ? rows : [{ params: {}, branchParams: {} }];
    const nextRows: typeof rows = [];

    for (const parent of parents) {
      const sourceParams = remapRouteParams(
        { ...requestParams, ...parent.params } as AppPageParams,
        source,
      );
      const branchParams = remapRouteParams(parent.branchParams as AppPageParams, source);
      const result = await callGenerateStaticParams(
        source,
        { ...pickRouteParams(sourceParams, source.parentParamNames), ...branchParams },
        parent.params,
        rootParams,
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

function isStaticParamsRowConsistentWithRequest(
  row: Record<string, unknown>,
  requestParams: AppPageParams,
): boolean {
  const sharedKeys = Object.keys(row).filter((key) => requestParams[key] !== undefined);
  return areStaticParamsAllowed(requestParams, [row], false, sharedKeys);
}

function rewritesParentParams(
  parentParams: Record<string, unknown>,
  item: Record<string, unknown>,
): boolean {
  return Object.keys(item).some(
    (key) =>
      Object.hasOwn(parentParams, key) &&
      JSON.stringify(item[key]) !== JSON.stringify(parentParams[key]),
  );
}

type GeneratedStaticParamsRow = {
  params: Record<string, unknown>;
  // Identifies the row by its position in the generation tree, so a rerun
  // finds the results its first pass returned even when rows share params.
  lineage: string;
};

// Before a generator runs, Next.js makes its segment's own `fetchCache` the
// mode for it and the generators after it.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
function applySourceFetchCache(source: GenerateStaticParamsSource): void {
  if (source.fetchCache !== undefined) setCurrentFetchCacheMode(source.fetchCache);
}

async function generateChainedStaticParams(
  sources: readonly GenerateStaticParamsSource[],
  requestParams: AppPageParams | null,
  rootParams: GeneratorRootParams,
  // The mode each pass starts from, when the caller sets one.
  initialFetchCache: FetchCacheMode | null | undefined,
  // A rerun over every combination reuses the results each generator already
  // returned, so it calls generators only for the parents it skipped.
  results = new Map<GenerateStaticParamsSource, Map<string, unknown>>(),
  // Where no parent agrees with the request, run every parent instead of one,
  // for a caller that reads whether the rows have every param.
  everyUnmatchedParent = false,
): Promise<Record<string, unknown>[]> {
  let generatedRows: GeneratedStaticParamsRow[] = [];
  let skippedParents = false;
  let needsEveryCombination = false;
  if (initialFetchCache !== undefined) setCurrentFetchCacheMode(initialFetchCache);

  for (const source of sources) {
    applySourceFetchCache(source);
    let sourceResults = results.get(source);
    if (!sourceResults) {
      sourceResults = new Map();
      results.set(source, sourceResults);
    }
    const hasParentParams = generatedRows.length > 0;
    let parents = hasParentParams ? generatedRows : [{ params: {}, lineage: "" }];
    const nextRows: GeneratedStaticParamsRow[] = [];

    // Every child row inherits its parent's params, so a parent combination
    // that already disagrees with the request cannot produce it, and its
    // generator call is skipped. When none agrees, one still runs so a
    // generator that rewrites parent params is observed, or every one runs
    // for a caller that reads whether the rows have every param.
    if (requestParams) {
      const consistent = parents.filter((row) =>
        isStaticParamsRowConsistentWithRequest(row.params, requestParams),
      );
      if (consistent.length > 0) parents = consistent;
      else if (!everyUnmatchedParent) parents = parents.slice(0, 1);
    }
    if (hasParentParams && parents.length < generatedRows.length) skippedParents = true;

    for (const parent of parents) {
      let result = sourceResults.get(parent.lineage);
      if (!sourceResults.has(parent.lineage)) {
        result = await callGenerateStaticParams(
          source,
          parent.params as AppPageParams,
          parent.params,
          rootParams,
        );
        sourceResults.set(parent.lineage, result);
      }
      if (Array.isArray(result) && result.length > 0) {
        result.forEach((item, index) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) return;
          const row = item as Record<string, unknown>;
          if (skippedParents && rewritesParentParams(parent.params, row)) {
            needsEveryCombination = true;
          }
          nextRows.push({
            params: { ...parent.params, ...row },
            lineage: `${parent.lineage}/${index}`,
          });
        });
      } else if (hasParentParams) {
        // Match Next's non-PPR generation: an empty child result preserves
        // each already-generated parent combination.
        nextRows.push({ params: parent.params, lineage: `${parent.lineage}/-` });
      }
    }

    if (skippedParents && nextRows.length === 0) needsEveryCombination = true;
    generatedRows = nextRows;
  }

  // Next merges each result over its parent combination, so a generator that
  // rewrites a parent param can produce the request from a skipped parent.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
  if (needsEveryCombination)
    return generateChainedStaticParams(sources, null, rootParams, initialFetchCache, results);
  return generatedRows.map((row) => row.params);
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

export function routePatternParamNames(patternParts: readonly string[]): string[] {
  return patternParts.flatMap((part) => {
    const markerParam = interceptionMarkerPatternParam(part);
    if (markerParam) return [markerParam.name];
    if (!part.startsWith(":")) return [];
    return [part.slice(1, part.endsWith("+") || part.endsWith("*") ? -1 : undefined)];
  });
}

export function routePatternOptionalCatchAllParamNames(patternParts: readonly string[]): string[] {
  return patternParts.flatMap((part) =>
    part.startsWith(":") && part.endsWith("*") ? [part.slice(1, -1)] : [],
  );
}

export async function validateAppPageDynamicParams(
  options: ValidateAppPageDynamicParamsOptions,
): Promise<Response | null> {
  return (await checkAppPageDynamicParams(options)).response;
}

export async function checkAppPageDynamicParams(
  options: ValidateAppPageDynamicParamsOptions,
): Promise<AppPageDynamicParamsCheck> {
  if (!options.enforceStaticParamsOnly || !options.isDynamicRoute) {
    return renderCheck;
  }

  const generateStaticParamsSources = normalizeGenerateStaticParams(options.generateStaticParams);
  const generatorRootParams: GeneratorRootParams = options.rootParamNames
    ? {
        names: options.rootParamNames,
        route: options.routePattern ? patternToNextFormat(options.routePattern) : "",
      }
    : undefined;
  const everyParamNames = options.enforceWhenEveryParamGenerated;
  if (generateStaticParamsSources.length === 0) {
    return everyParamNames ? renderCheck : notFoundCheck();
  }
  const rowsHaveEveryParam = (rows: readonly Record<string, unknown>[]) =>
    rows.length > 0 &&
    rows.every((row) => (everyParamNames ?? []).every((name) => Object.hasOwn(row, name)));

  const chainedSources = generateStaticParamsSources.filter((source) => source.chained);
  const hasIndependentSources = generateStaticParamsSources.some((source) => !source.chained);
  let chainedStaticParams: Record<string, unknown>[] | null = null;
  // Shared by a confirming pass over every parent, so it calls generators only
  // for the parents the request's pass skipped.
  const chainedResults = new Map<GenerateStaticParamsSource, Map<string, unknown>>();
  if (chainedSources.length > 0) {
    // Next walks the loader-tree segments top-down. Route groups are real
    // loader-tree segments even though they do not appear in the URL, so a
    // generateStaticParams exported by a grouped layout receives everything
    // generated by its parent layouts.
    // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
    //
    // Parallel generators merge their results over each primary combination
    // and may rewrite primary params, so they receive every combination.
    chainedStaticParams = await generateChainedStaticParams(
      chainedSources,
      hasIndependentSources ? null : options.params,
      generatorRootParams,
      options.initialFetchCache,
      chainedResults,
      everyParamNames !== undefined && !hasIndependentSources,
    );
  }

  if (everyParamNames && !hasIndependentSources) {
    const rows = chainedStaticParams ?? [];
    // Any generated row without a param shows Next.js builds no paths for the
    // route, and a match renders either way. Only the rows the request's
    // parent params generate decide, so a miss runs no generator for the
    // other parents. Where the request's params match no parent, every
    // parent's rows decide, so the answer doesn't hang on their order.
    if (!rowsHaveEveryParam(rows)) return renderCheck;
    if (!areStaticParamsAllowed(options.params, rows)) return notFoundCheck();
    if (!options.confirmEveryParamGenerated) return renderCheck;
    // Next.js prerenders the route only when every parent's rows have every
    // param. Another parent's generator failing leaves the request to render
    // uncached, as it did before vinext ran it.
    try {
      const everyRow = await generateChainedStaticParams(
        chainedSources,
        null,
        generatorRootParams,
        options.initialFetchCache,
        chainedResults,
      );
      return { response: null, generatesEveryParam: rowsHaveEveryParam(everyRow) };
    } catch (error) {
      console.error(
        "[vinext] generateStaticParams failed while checking the route's paths:",
        error,
      );
      return renderCheck;
    }
  }

  const independentChains = new Map<unknown, GenerateStaticParamsSource[]>();
  for (const source of generateStaticParamsSources.filter((source) => !source.chained)) {
    const chain = independentChains.get(source.independentChain ?? source) ?? [];
    chain.push(source);
    independentChains.set(source.independentChain ?? source, chain);
  }

  const isAllowedByParallelRows = (rows: readonly Record<string, unknown>[]) =>
    areStaticParamsAllowed(
      options.params,
      rows,
      options.requiredParamNames === undefined,
      options.requiredParamNames,
      options.optionalCatchAllParamNames,
    );
  const independentRowSets: Record<string, unknown>[][] = [];
  for (const sources of independentChains.values()) {
    const result = await generateIndependentStaticParams(
      sources,
      chainedStaticParams,
      options.params,
      generatorRootParams,
    );
    if (!result.validated) continue;
    independentRowSets.push(result.staticParams);
    // A miss rejects at once, unless every chain's rows decide whether the
    // route enforces at all.
    if (!everyParamNames && !isAllowedByParallelRows(result.staticParams)) {
      return notFoundCheck();
    }
  }
  const validatedIndependentResults = independentRowSets.length > 0;

  if (everyParamNames) {
    // A parallel chain's rows extend the primary chain's. Next.js runs every
    // slot's generators in one chain, so a param that one chain gives each of
    // its rows reaches every final row.
    const rowSets = validatedIndependentResults ? independentRowSets : [chainedStaticParams ?? []];
    const hasEveryParam =
      rowSets.some((rows) => rows.length > 0) &&
      everyParamNames.every((name) =>
        rowSets.some((rows) => rows.length > 0 && rows.every((row) => Object.hasOwn(row, name))),
      );
    if (!hasEveryParam) return renderCheck;
    // An empty result keeps the rows before it, so only chains with rows
    // decide the match.
    const filledRowSets = independentRowSets.filter((rows) => rows.length > 0);
    if (!filledRowSets.every(isAllowedByParallelRows)) return notFoundCheck();
  }

  if (options.requiredParamNames && !validatedIndependentResults) {
    return notFoundCheck();
  }

  if (chainedStaticParams && !validatedIndependentResults) {
    // Next merges each generated result into its parent combination. Parallel
    // results are validated against those combinations above; without a
    // parallel result, the primary chain itself must match exactly.
    // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
    if (!areStaticParamsAllowed(options.params, chainedStaticParams)) {
      return notFoundCheck();
    }
  }

  // vinext checks each parallel route slot's chain on its own, where Next.js
  // runs every slot's generators in one chain, so it can't show that a route
  // with a slot generator has every param, and never stores one.
  return renderCheck;
}

type ValidateAppPageRouteDynamicParamsOptions = {
  dynamicConfig?: string;
  dynamicParamsConfig?: boolean;
  /** The fetchCache the generators start from. */
  fetchCache?: FetchCacheMode | null;
  generateStaticParams?: ValidateAppPageDynamicParamsOptions["generateStaticParams"];
  /**
   * Whether `generateStaticParams` sits at or below the route's last dynamic
   * segment (`lastDynamicSegmentHasGenerateStaticParams`).
   */
  hasGenerateStaticParams: boolean;
  isDynamicRoute: boolean;
  isProduction: boolean;
  /** Whether the route prerenders a fallback shell (`cacheComponents`). */
  isRoutePPREnabled?: boolean;
  /** Whether the route runs on the edge runtime, which Next.js never prerenders. */
  isStaticGenerationEdgeRuntime?: boolean;
  params: AppPageParams;
  /** The request's route-match pathname, compared with the exported paths. */
  pathname: string;
  /** The route's tree-wide `revalidate`, in seconds. */
  revalidateSeconds?: number | null;
  rootParamNames?: readonly string[];
  routePattern: string;
  routeSegments?: readonly string[];
};

/**
 * Whether a dynamic page admits only the params its generateStaticParams
 * lists. Under `output: "export"` Next.js writes only those params as files
 * and rejects `dynamicParams: true`, so the host answers 404 for every other
 * URL: a production export behaves as `dynamicParams = false`.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
 */
export function isAppPageStaticParamsOnly(
  dynamicParamsConfig: boolean | undefined,
  isProduction: boolean,
): boolean {
  if (dynamicParamsConfig === false) return true;
  return isProduction && process.env.__NEXT_CONFIG_OUTPUT === "export";
}

/**
 * Next.js rejects a `dynamicParams = false` miss while routing, before any of
 * the route's segments render: it serves `/_not-found` instead. It does so
 * only where it prerenders the route's paths (see
 * `resolveAppPageDynamicParamsConfig`).
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/base-server.ts
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
 */
export async function validateAppPageRouteDynamicParams(
  options: ValidateAppPageRouteDynamicParamsOptions,
): Promise<Response | null> {
  return (await checkAppPageRouteDynamicParams(options)).response;
}

/**
 * `validateAppPageRouteDynamicParams`, which also reports whether Next.js
 * prerenders the request's path because the generators give every param.
 * Pass `confirmEveryParamGenerated` to learn that.
 */
export function checkAppPageRouteDynamicParams(
  options: ValidateAppPageRouteDynamicParamsOptions & { confirmEveryParamGenerated?: boolean },
): Promise<AppPageDynamicParamsCheck> {
  // Next.js' production force-dynamic routes are absent from the prerender
  // manifest, so they never enter its generated-path fallback gate. Dev still
  // resolves and exact-matches generateStaticParams for the same route.
  if (options.isProduction && options.dynamicConfig === "force-dynamic") {
    return Promise.resolve(renderCheck);
  }
  // A deployed export serves a dynamic page only at the paths its build wrote,
  // whatever generateStaticParams returns now. The prerender that writes them
  // still checks the generators. It records `/about` for the `/about/` that
  // trailingSlash routes, so compare without the trailing slash.
  if (
    options.isDynamicRoute &&
    options.isProduction &&
    process.env.__NEXT_CONFIG_OUTPUT === "export" &&
    process.env.VINEXT_PRERENDER !== "1"
  ) {
    const exported = getRenderedConcreteUrlPathsForRoute(options.routePattern)?.has(
      removeTrailingSlash(options.pathname),
    );
    return Promise.resolve(exported === true ? renderCheck : notFoundCheck());
  }
  // So are its production `revalidate = 0` routes, outside an export.
  if (options.isProduction && options.revalidateSeconds === 0) {
    return Promise.resolve(renderCheck);
  }
  const isExport = options.isProduction && process.env.__NEXT_CONFIG_OUTPUT === "export";
  // Next.js builds no paths for an edge route, so it has none to enforce.
  const enforcesDynamicParams =
    options.dynamicParamsConfig === false && options.isStaticGenerationEdgeRuntime !== true;
  // Next.js prerenders a fallback shell for every `cacheComponents` route,
  // and a production build prerenders a `force-static` or `dynamic = "error"`
  // route, whatever its generators give. Otherwise it prerenders the route
  // when its last dynamic segment has a generator, or when the generators
  // give every param. A route without prerendered paths renders any params.
  const alwaysBuildsPaths =
    isExport ||
    options.isRoutePPREnabled === true ||
    options.hasGenerateStaticParams ||
    (options.isProduction &&
      (options.dynamicConfig === "force-static" || options.dynamicConfig === "error"));
  // Next.js runs generateStaticParams in a work store of its own: the route's
  // implicit tags, no revalidate or force-dynamic default, and the fetchCache
  // of each generator's segment (see applySourceFetchCache). A route without
  // per-source modes approximates them with its tree-wide one.
  // Callers run this check apart from the request, so these stay out of it.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
  setCurrentFetchCacheMode(options.fetchCache ?? null);
  setCurrentFetchSoftTags(buildAppStaticParamsTags(options.routeSegments ?? []));
  setCurrentFetchRevalidate(null);
  setCurrentForceDynamicFetchDefault(false);
  return checkAppPageDynamicParams({
    enforceStaticParamsOnly: enforcesDynamicParams || isExport,
    ...(alwaysBuildsPaths
      ? {}
      : {
          confirmEveryParamGenerated: options.confirmEveryParamGenerated,
          enforceWhenEveryParamGenerated: routeSegmentParamNames(
            options.routeSegments,
            options.params,
          ),
        }),
    generateStaticParams: options.generateStaticParams,
    initialFetchCache: options.fetchCache ?? null,
    isDynamicRoute: options.isDynamicRoute,
    params: options.params,
    rootParamNames: options.rootParamNames,
    routePattern: options.routePattern,
  });
}

/** The URL params a route's segments name, an interception's included. */
function routeSegmentParamNames(
  routeSegments: readonly string[] | undefined,
  params: AppPageParams,
): string[] {
  if (!routeSegments) return Object.keys(params);
  const names = routeSegments.flatMap((segment) => {
    const name = getAppPageSegmentParamName(withoutInterceptionMarker(segment));
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

export async function resolveAppPageInterceptState<TRoute, TPage>(
  options: AppPageInterceptStateLookup<TRoute, TPage>,
): Promise<AppPageInterceptState<TRoute, TPage>> {
  if (options.interceptState) return options.interceptState;
  if (!options.isRscRequest) {
    return { kind: "none" };
  }

  const intercept = options.findIntercept(options.cleanPathname);
  if (!intercept) {
    return { kind: "none" };
  }

  await loadAppInterceptPage(intercept);
  await loadAppInterceptNotFound(intercept);
  // The owner's `default` takes part in the interception's params check.
  await loadAppInterceptOwnerDefault(intercept);
  if (
    intercept.__loadInterceptLayouts ||
    intercept.__loadInterceptLoadings ||
    intercept.__loadInterceptNotFounds ||
    intercept.__loadInterceptForbiddens ||
    intercept.__loadInterceptUnauthorizeds ||
    intercept.__loadInterceptErrors
  ) {
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

/**
 * Marks the opts of a render of the source route beneath its intercepted
 * target, which renders only the intercepting route's tree (see
 * app-page-element-builder.ts). Without a source that shares that tree, the
 * render is of the tree whole, with the slot owner's `default` as its children.
 */
export function markInterceptionSourceRender<TInterceptOpts, TPage>(
  opts: TInterceptOpts,
  intercept: AppPageInterceptMatch<TPage>,
): TInterceptOpts {
  if (typeof opts !== "object" || opts === null) return opts;
  return intercept.rendersWholeInterceptingRoute
    ? {
        ...opts,
        interceptOwnerDefault: intercept.ownerDefault ?? null,
        rendersInterceptionSource: true,
        rendersWholeInterceptingRoute: true,
      }
    : { ...opts, rendersInterceptionSource: true };
}

/**
 * The root params of a render of an interception's source, or null for any
 * other render, which keeps the request's. Next.js's interception rewrite
 * renders the intercepting route under the values it captures from the
 * source, so the source render's root params come from the source's params,
 * as its layouts' params do.
 */
export function resolveAppPageInterceptionSourceRootParams(
  route: { rootParamNames?: readonly string[] | null },
  params: AppPageParams,
  interceptOpts: unknown,
): RootParams | null {
  return isUnknownRecord(interceptOpts) && interceptOpts.rendersInterceptionSource === true
    ? pickRootParams(params, route.rootParamNames)
    : null;
}

export async function resolveAppPageInterceptionRerenderTarget<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptionRerenderTargetOptions<TRoute, TPage, TInterceptOpts>,
): Promise<ResolveAppPageInterceptionRerenderTargetResult<TRoute, TInterceptOpts>> {
  const interceptState = await resolveAppPageInterceptState({
    cleanPathname: options.cleanPathname,
    currentRoute: options.currentRoute,
    findIntercept: options.findIntercept,
    getSourceRoute: options.getSourceRoute,
    interceptState: options.interceptState,
    isRscRequest: options.isRscRequest,
  });

  if (interceptState.kind === "source-route") {
    const sourceMatchedParams =
      interceptState.intercept.sourceMatchedParams ?? interceptState.intercept.matchedParams;
    return {
      interceptOpts: markInterceptionSourceRender(
        options.toInterceptOpts(interceptState.intercept),
        interceptState.intercept,
      ),
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

  if (
    interceptState.kind === "current-route" &&
    rendersCurrentRouteAsSource(interceptState.intercept)
  ) {
    return {
      ...resolveAppPageCurrentRouteSourceParams(
        interceptState.intercept,
        options.getRouteParamNames(options.currentRoute),
      ),
      interceptOpts: markInterceptionSourceRender(
        options.toInterceptOpts(interceptState.intercept),
        interceptState.intercept,
      ),
      route: options.currentRoute,
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

/**
 * A source URL that resolved to no route of its own (`/shots` beside
 * `shots/@modal/(.)[id]` with no `shots/page`) names no page beneath the
 * modal, so the matched route renders whole with the target's params.
 */
function rendersCurrentRouteAsSource<TPage>(intercept: AppPageInterceptMatch<TPage>): boolean {
  return intercept.sourceRouteIsConcrete !== false;
}

/**
 * An interception whose source is the matched route itself (`/shots/1` to
 * `/shots/2` beside `@modal/(.)[id]`) still renders beneath the source's
 * params, as Next.js keeps the source page under the modal. The client reads
 * the target's from the navigation params.
 */
function resolveAppPageCurrentRouteSourceParams<TPage>(
  intercept: AppPageInterceptMatch<TPage>,
  routeParamNames: readonly string[],
): { navigationParams: AppPageParams; params: AppPageParams } {
  const sourceMatchedParams = intercept.sourceMatchedParams ?? intercept.matchedParams;
  return {
    navigationParams: { ...sourceMatchedParams, ...intercept.matchedParams },
    params: pickRouteParams(sourceMatchedParams, routeParamNames),
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
    getSourceRoute: options.getSourceRoute,
    interceptState: options.interceptState,
    isRscRequest: options.isRscRequest,
  });

  if (interceptState.kind === "source-route") {
    const renderRoute = interceptState.sourceRoute;
    const interceptOpts = markInterceptionSourceRender(
      options.toInterceptOpts(interceptState.intercept),
      interceptState.intercept,
    );
    const sourceMatchedParams =
      interceptState.intercept.sourceMatchedParams ?? interceptState.intercept.matchedParams;
    const navigationParams = {
      ...sourceMatchedParams,
      ...interceptState.intercept.matchedParams,
    };
    const renderSearchParams = options.resolveSearchParams
      ? await options.resolveSearchParams(renderRoute, options.searchParams, interceptOpts)
      : options.searchParams;
    const renderParams = pickRouteParams(
      sourceMatchedParams,
      options.getRouteParamNames(interceptState.sourceRoute),
    );

    const resolvedNavigationParams = options.resolveNavigationParams(
      renderRoute,
      navigationParams,
      options.cleanPathname,
      interceptOpts,
    );
    options.setNavigationContext({
      params: resolvedNavigationParams,
      pathname: options.cleanPathname,
      searchParams: renderSearchParams,
    });
    const interceptElement = await options.buildPageElement(
      renderRoute,
      renderParams,
      interceptOpts,
      renderSearchParams,
    );

    return {
      interceptOpts: undefined,
      response: await options.renderInterceptResponse(
        renderRoute,
        interceptElement,
        resolvedNavigationParams,
      ),
    };
  }

  // The current route is the source: it renders as itself, with the opts bag
  // and the source's params, rather than as a separate intercepted response.
  if (
    interceptState.kind === "current-route" &&
    rendersCurrentRouteAsSource(interceptState.intercept)
  ) {
    return {
      ...resolveAppPageCurrentRouteSourceParams(
        interceptState.intercept,
        options.getRouteParamNames(options.currentRoute),
      ),
      interceptOpts: markInterceptionSourceRender(
        options.toInterceptOpts(interceptState.intercept),
        interceptState.intercept,
      ),
      response: null,
    };
  }
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
    const specialError = options.resolveSpecialError(error);
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
