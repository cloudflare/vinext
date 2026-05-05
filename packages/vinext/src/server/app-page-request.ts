import type { AppPageSpecialError } from "./app-page-execution.js";
import { getAppPageSegmentParamName } from "./app-page-params.js";
import { notFoundResponse } from "./http-error-responses.js";

type AppPageParams = Record<string, string | string[]>;
type GenerateStaticParams = (args: { params: AppPageParams }) => unknown;

type GenerateStaticParamsModule = {
  generateStaticParams?: GenerateStaticParams | null;
};

type GenerateStaticParamsSource = {
  generateStaticParams: GenerateStaticParams;
  parentParamNames: readonly string[];
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
  logGenerateStaticParamsError?: (error: unknown) => void;
  params: AppPageParams;
};

type ResolveAppPageGenerateStaticParamsSourcesOptions = {
  layouts?: readonly (GenerateStaticParamsModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: GenerateStaticParamsModule | null;
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
  matchedParams: AppPageParams;
  page: TPage;
  slotKey: string;
  sourceRouteIndex: number;
};

type ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts> = {
  cleanPathname: string;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
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

type ResolveAppPageActionRerenderTargetOptions<TRoute, TPage, TInterceptOpts> = {
  cleanPathname: string;
  currentParams: AppPageParams;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  isRscRequest: boolean;
  toInterceptOpts: (intercept: AppPageInterceptMatch<TPage>) => TInterceptOpts;
};

type ResolveAppPageActionRerenderTargetResult<TRoute, TInterceptOpts> = {
  interceptOpts: TInterceptOpts | undefined;
  navigationParams: AppPageParams;
  params: AppPageParams;
  route: TRoute;
};

type ResolveAppPageInterceptOptions<TRoute, TPage, TInterceptOpts, TElement> = {
  buildPageElement: (
    route: TRoute,
    params: AppPageParams,
    interceptOpts: TInterceptOpts | undefined,
    searchParams: URLSearchParams,
  ) => Promise<TElement>;
  cleanPathname: string;
  currentRoute: TRoute;
  findIntercept: (pathname: string) => AppPageInterceptMatch<TPage> | null;
  getRouteParamNames: (route: TRoute) => readonly string[];
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  isRscRequest: boolean;
  renderInterceptResponse: (route: TRoute, element: TElement) => Promise<Response> | Response;
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

function getLayoutGenerateStaticParamsBoundary(layoutTreePosition: number | undefined): number {
  // A layout at app/[id]/layout.tsx has tree position 1, but its
  // generateStaticParams belongs to the [id] segment and receives only parent
  // params from segments before [id].
  return (layoutTreePosition ?? 0) - 1;
}

export function resolveAppPageGenerateStaticParamsSources(
  options: ResolveAppPageGenerateStaticParamsSourcesOptions,
): GenerateStaticParamsSource[] {
  const sources: GenerateStaticParamsSource[] = [];

  options.layouts?.forEach((layout, index) => {
    if (typeof layout?.generateStaticParams !== "function") return;

    sources.push({
      generateStaticParams: layout.generateStaticParams,
      parentParamNames: collectParentParamNames(
        options.routeSegments,
        getLayoutGenerateStaticParamsBoundary(options.layoutTreePositions?.[index]),
      ),
    });
  });

  if (typeof options.page?.generateStaticParams === "function") {
    sources.push({
      generateStaticParams: options.page.generateStaticParams,
      parentParamNames: collectParentParamNames(
        options.routeSegments,
        Math.max(0, options.routeSegments.length - 1),
      ),
    });
  }

  return sources;
}

function areStaticParamsAllowed(
  params: AppPageParams,
  staticParams: readonly Record<string, unknown>[],
): boolean {
  const paramKeys = Object.keys(params);

  return staticParams.some((staticParamSet) =>
    paramKeys.every((key) => {
      const value = params[key];
      const staticValue = staticParamSet[key];

      // Parent params may not appear in the leaf route's returned set because
      // Next.js passes them top-down through nested generateStaticParams calls.
      if (staticValue === undefined) {
        return true;
      }

      if (Array.isArray(value)) {
        return JSON.stringify(value) === JSON.stringify(staticValue);
      }

      if (
        typeof staticValue === "string" ||
        typeof staticValue === "number" ||
        typeof staticValue === "boolean"
      ) {
        return String(value) === String(staticValue);
      }

      return JSON.stringify(value) === JSON.stringify(staticValue);
    }),
  );
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

  for (const source of generateStaticParamsSources) {
    try {
      const staticParams = await source.generateStaticParams({
        params: pickRouteParams(options.params, source.parentParamNames),
      });
      if (Array.isArray(staticParams) && !areStaticParamsAllowed(options.params, staticParams)) {
        options.clearRequestContext();
        return notFoundResponse();
      }
    } catch (error) {
      options.logGenerateStaticParamsError?.(error);
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
export function resolveAppPageInterceptMatch<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts>,
): ResolveAppPageInterceptMatchResult<TRoute, TInterceptOpts> | null {
  const interceptState = resolveAppPageInterceptState(options);
  if (interceptState.kind !== "source-route") {
    return null;
  }

  return {
    interceptOpts: options.toInterceptOpts(interceptState.intercept),
    matchedParams: interceptState.intercept.matchedParams,
    sourceParams: pickRouteParams(
      interceptState.intercept.matchedParams,
      options.getRouteParamNames(interceptState.sourceRoute),
    ),
    sourceRoute: interceptState.sourceRoute,
  };
}

function resolveAppPageInterceptState<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageInterceptMatchOptions<TRoute, TPage, TInterceptOpts>,
): AppPageInterceptState<TRoute, TPage> {
  if (!options.isRscRequest) {
    return { kind: "none" };
  }

  const intercept = options.findIntercept(options.cleanPathname);
  if (!intercept) {
    return { kind: "none" };
  }

  const sourceRoute = options.getSourceRoute(intercept.sourceRouteIndex);
  if (!sourceRoute) {
    return { kind: "none" };
  }

  if (sourceRoute === options.currentRoute) {
    return { kind: "current-route", intercept };
  }

  return { kind: "source-route", intercept, sourceRoute };
}

export function resolveAppPageActionRerenderTarget<TRoute, TPage, TInterceptOpts>(
  options: ResolveAppPageActionRerenderTargetOptions<TRoute, TPage, TInterceptOpts>,
): ResolveAppPageActionRerenderTargetResult<TRoute, TInterceptOpts> {
  const interceptState = resolveAppPageInterceptState({
    cleanPathname: options.cleanPathname,
    currentRoute: options.currentRoute,
    findIntercept: options.findIntercept,
    getRouteParamNames: options.getRouteParamNames,
    getSourceRoute: options.getSourceRoute,
    isRscRequest: options.isRscRequest,
    toInterceptOpts: options.toInterceptOpts,
  });

  if (interceptState.kind === "source-route") {
    return {
      interceptOpts: options.toInterceptOpts(interceptState.intercept),
      navigationParams: interceptState.intercept.matchedParams,
      params: pickRouteParams(
        interceptState.intercept.matchedParams,
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

export async function resolveAppPageIntercept<TRoute, TPage, TInterceptOpts, TElement>(
  options: ResolveAppPageInterceptOptions<TRoute, TPage, TInterceptOpts, TElement>,
): Promise<ResolveAppPageInterceptResult<TInterceptOpts>> {
  const interceptState = resolveAppPageInterceptState({
    cleanPathname: options.cleanPathname,
    currentRoute: options.currentRoute,
    findIntercept: options.findIntercept,
    getRouteParamNames: options.getRouteParamNames,
    getSourceRoute: options.getSourceRoute,
    isRscRequest: options.isRscRequest,
    toInterceptOpts: options.toInterceptOpts,
  });

  if (interceptState.kind === "source-route") {
    options.setNavigationContext({
      params: interceptState.intercept.matchedParams,
      pathname: options.cleanPathname,
      searchParams: options.searchParams,
    });
    const interceptElement = await options.buildPageElement(
      interceptState.sourceRoute,
      pickRouteParams(
        interceptState.intercept.matchedParams,
        options.getRouteParamNames(interceptState.sourceRoute),
      ),
      options.toInterceptOpts(interceptState.intercept),
      options.searchParams,
    );

    return {
      interceptOpts: undefined,
      response: await options.renderInterceptResponse(interceptState.sourceRoute, interceptElement),
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
