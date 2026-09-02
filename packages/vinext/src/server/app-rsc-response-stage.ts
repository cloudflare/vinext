import {
  applyEffectiveRequestCookieHeader,
  headersContextFromRequest,
  restoreDraftModeTransition,
} from "vinext/shims/headers";
import { ensureFetchPatch, setCurrentFetchSoftTags } from "vinext/shims/fetch-cache";
import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";
import { pickRootParams, setRootParams } from "vinext/shims/root-params";
import {
  closeAfterResponse,
  closeAfterResponseWithBody,
  createRequestContext,
  runWithRequestContext,
} from "vinext/shims/unified-request-context";
import type { AppRscHandlerRoute, CreateAppRscHandlerOptions } from "./app-rsc-handler.js";
import {
  APP_METADATA_RESPONSE_STAGE_NO_MATCH_HEADER,
  APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  type AppMatchedWorkerResponseStageProps,
  type AppWorkerResponseStageProps,
} from "./app-worker-stages.js";
import type { VinextResponseStageDispatchOptions } from "./multi-stage.js";
import type { AppMiddlewareContext } from "./app-middleware.js";
import type { AppPagePprFallbackCacheShell } from "./app-ppr-fallback-shell.js";
import { normalizeRscRequest } from "./app-rsc-request-normalization.js";
import {
  hasRscCacheBustingSearchParam,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
} from "./app-rsc-cache-busting.js";
import { VINEXT_REVALIDATE_HOST_HEADER } from "./headers.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import { getRenderedConcreteUrlPathsForRoute } from "./pregenerated-concrete-paths.js";
import { runWithPrerenderWorkUnit } from "./prerender-work-unit-setup.js";
import {
  cloneRequestWithHeaders,
  cloneRequestWithUrl,
  filterInternalHeaders,
} from "./request-pipeline.js";

type AppPageParams = Record<string, string | string[]>;

function haveSamePageParams(first: AppPageParams, second: AppPageParams): boolean {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) return false;
  for (const key of firstKeys) {
    const firstValue = first[key];
    const secondValue = second[key];
    if (Array.isArray(firstValue)) {
      if (
        !Array.isArray(secondValue) ||
        firstValue.length !== secondValue.length ||
        firstValue.some((value, index) => value !== secondValue[index])
      ) {
        return false;
      }
    } else if (firstValue !== secondValue) {
      return false;
    }
  }
  return true;
}

function hasProperty<TKey extends PropertyKey>(
  value: object,
  key: TKey,
): value is object & Record<TKey, unknown> {
  return key in value;
}

function isEdgeRouteHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== "object" || !hasProperty(handler, "runtime")) return false;
  return handler.runtime === "edge" || handler.runtime === "experimental-edge";
}

function isExecutionContextLike(value: unknown): value is ExecutionContextLike {
  return (
    !!value &&
    typeof value === "object" &&
    hasProperty(value, "waitUntil") &&
    typeof value.waitUntil === "function"
  );
}

function requestWithoutRscCacheBustingSearchParam(request: Request): Request {
  const url = new URL(request.url);
  if (!hasRscCacheBustingSearchParam(url)) return request;
  stripRscCacheBustingSearchParam(url);
  return cloneRequestWithUrl(request, url.toString());
}

function requestWithoutRscSuffix(request: Request): Request {
  const url = new URL(request.url);
  const pathname = stripRscSuffix(url.pathname);
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return cloneRequestWithUrl(request, url.toString());
}

function pathnameForResolvedUrl(resolvedUrl: string): string {
  return resolvedUrl.split("#", 1)[0].split("?", 1)[0];
}

function rematchAppWorkerResponseStageRoute<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  normalized: Exclude<ReturnType<typeof normalizeRscRequest>, Response>,
  props: AppMatchedWorkerResponseStageProps,
): { params: AppPageParams; route: TRoute } | null {
  let match: { params: AppPageParams; route: TRoute } | null = null;
  if (props.matchKind === "interception") {
    if (normalized.interceptionContextHeader !== null) {
      match =
        options.matchInterceptRoute?.(
          props.routePathname,
          normalized.interceptionContextHeader,
          props.interceptionId,
        ) ?? null;
    }
  } else if (props.matchKind === "request") {
    match = options.matchRequestRoute?.(props.routePathname) ?? null;
  } else {
    match = options.matchRoute(props.routePathname);
  }
  if (!match) return null;
  if (
    match.route.pattern !== props.routePattern ||
    !haveSamePageParams(match.params, props.params)
  ) {
    return null;
  }
  return match;
}

export async function renderAppWorkerResponseStage<TRoute extends AppRscHandlerRoute>(
  options: CreateAppRscHandlerOptions<TRoute>,
  rawRequest: Request,
  ctx: unknown,
  props: AppWorkerResponseStageProps,
  _stageOptions?: VinextResponseStageDispatchOptions,
): Promise<Response> {
  if (
    props.protocolVersion !== APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION ||
    props.buildId !== options.buildId
  ) {
    return new Response("Incompatible vinext App response stage", { status: 409 });
  }
  if (props.kind === "app-full-request") {
    return new Response("Invalid vinext App response stage", { status: 400 });
  }
  options.registerCacheAdapters();
  await options.ensureInstrumentation?.();

  const executionContext = isExecutionContextLike(ctx)
    ? ctx
    : (getRequestExecutionContext() ?? null);
  const filteredHeaders = executionContext?.isInternalPagesRevalidation
    ? new Headers(rawRequest.headers)
    : filterInternalHeaders(rawRequest.headers);
  filteredHeaders.delete(VINEXT_REVALIDATE_HOST_HEADER);
  const request = cloneRequestWithHeaders(rawRequest, filteredHeaders);
  if (props.kind === "hybrid-pages") {
    try {
      if (new URL(props.requestUrl).origin !== new URL(request.url).origin) {
        return new Response("Invalid vinext App response stage", { status: 400 });
      }
    } catch {
      return new Response("Invalid vinext App response stage", { status: 400 });
    }
  }
  const liveNormalized = normalizeRscRequest(request, options.basePath, true);
  if (liveNormalized instanceof Response) {
    return new Response("Invalid vinext App response stage", { status: 400 });
  }
  // Classification belongs to the pre-middleware request stage. Middleware
  // may legally override these headers for userland; keep those live headers
  // on `request`, but never let them mutate the trusted stage operation.
  const normalized =
    props.kind === "hybrid-pages"
      ? liveNormalized
      : {
          ...liveNormalized,
          interceptionContextHeader:
            props.kind === "app-page" || props.kind === "app-route-handler"
              ? props.interceptionContext
              : liveNormalized.interceptionContextHeader,
          interceptionIdHeader:
            props.kind === "app-page" || props.kind === "app-route-handler"
              ? props.interceptionId
              : liveNormalized.interceptionIdHeader,
          isRscRequest: props.isRscRequest,
          mountedSlotsHeader: props.mountedSlotsHeader,
          renderMode: props.renderMode,
        };
  const match =
    props.kind === "hybrid-pages" || props.kind === "app-metadata" || props.kind === "app-not-found"
      ? null
      : rematchAppWorkerResponseStageRoute(options, normalized, props);
  if (
    props.kind !== "hybrid-pages" &&
    props.kind !== "app-metadata" &&
    props.kind !== "app-not-found" &&
    !match
  ) {
    return new Response("Invalid vinext App response stage", { status: 400 });
  }

  const route = match?.route ?? null;
  if (route) {
    if (options.ensureRouteLoaded) await options.ensureRouteLoaded(route);
    if (
      (props.kind === "app-page" && route.routeHandler) ||
      (props.kind === "app-route-handler" && !route.routeHandler)
    ) {
      return new Response("Invalid vinext App response stage", { status: 400 });
    }
  }

  const headersContext = headersContextFromRequest(request, {
    draftModeSecret: options.draftModeSecret,
  });
  const requestContext = createRequestContext({
    headersContext,
    executionContext,
    unstableCacheRevalidation: "background",
  });
  const middlewareContext: AppMiddlewareContext = {
    headers: null,
    requestHeaders: null,
    status: null,
  };

  const responsePromise = runWithRequestContext(requestContext, () =>
    runWithPrerenderWorkUnit(
      async () => {
        if (props.middlewareCookieOverlay !== null) {
          applyEffectiveRequestCookieHeader(props.middlewareCookieOverlay);
        }
        if (props.draftModeCookie !== null) {
          restoreDraftModeTransition(props.draftModeCookie);
        }
        ensureFetchPatch();
        if (props.kind === "app-metadata") {
          if (!options.handleMetadataRouteRequest) {
            return new Response("Invalid vinext App response stage", { status: 400 });
          }
          const response = await options.handleMetadataRouteRequest(props.cleanPathname);
          return (
            response ??
            new Response(null, {
              status: 204,
              headers: { [APP_METADATA_RESPONSE_STAGE_NO_MATCH_HEADER]: "1" },
            })
          );
        }
        if (props.kind === "app-not-found") {
          options.setNavigationContext({
            pathname: props.canonicalPathname,
            searchParams: new URL(props.resolvedUrl, request.url).searchParams,
            params: {},
          });
          setRootParams({});
          const response = await options.renderNotFound({
            isRscRequest: normalized.isRscRequest,
            middlewareContext,
            request,
            route: null,
            scriptNonce: props.scriptNonce ?? undefined,
          });
          return response ?? new Response("Not Found", { status: 404 });
        }
        if (props.kind === "hybrid-pages") {
          if (!options.renderPagesFallback) {
            return new Response("Invalid vinext App response stage", { status: 400 });
          }
          const resolvedPathname = pathnameForResolvedUrl(props.resolvedUrl);
          const resolvedResourceKind =
            resolvedPathname === "/api" || resolvedPathname.startsWith("/api/") ? "api" : "page";
          if (resolvedResourceKind !== props.resourceKind) {
            return new Response("Invalid vinext App response stage", { status: 400 });
          }
          const pageRequest = props.isDataRequest
            ? cloneRequestWithUrl(request, new URL(props.resolvedUrl, request.url).toString())
            : request;
          const pagesResponse = await options.renderPagesFallback({
            allowRscDocumentFallback: props.allowRscDocumentFallback,
            appRouteMatch: props.appRouteMatch
              ? {
                  route: {
                    isDynamic: props.appRouteMatch.isDynamic,
                    pattern: props.appRouteMatch.pattern,
                  },
                }
              : null,
            isDataRequest: props.isDataRequest,
            isRscRequest: props.isRscRequest,
            matchKind: props.matchKind,
            middlewareContext,
            initialResponseHeaders:
              props.preHandlerHeaders === null ? undefined : new Headers(props.preHandlerHeaders),
            pathname: props.resolvedUrl,
            pagesDataRequest: props.isDataRequest ? request : null,
            request: pageRequest,
            url: new URL(props.requestUrl),
          });
          if (!pagesResponse) {
            return new Response("Invalid vinext App response stage", { status: 404 });
          }
          return pagesResponse;
        }

        if (!route) {
          return new Response("Invalid vinext App response stage", { status: 400 });
        }
        const searchParams = new URL(props.resolvedUrl, request.url).searchParams;
        const renderParams = props.params;
        options.setNavigationContext({
          pathname: props.canonicalPathname,
          searchParams,
          params: renderParams,
        });
        const rootParams = pickRootParams(renderParams, route.rootParamNames);
        setRootParams(rootParams);

        if (props.kind === "app-route-handler") {
          setCurrentFetchSoftTags(
            buildPageCacheTags(props.cleanPathname, [], [...route.routeSegments], "route"),
          );
          const normalizedUserlandRequest = requestWithoutRscSuffix(request);
          const userlandRequest =
            requestWithoutRscCacheBustingSearchParam(normalizedUserlandRequest);
          const routeHandlerRequest = isEdgeRouteHandler(route.routeHandler)
            ? userlandRequest
            : normalizedUserlandRequest;
          const routeHandlerUrl = new URL(routeHandlerRequest.url);
          const internalRscValues = isEdgeRouteHandler(route.routeHandler)
            ? []
            : routeHandlerUrl.searchParams.getAll(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM);
          routeHandlerUrl.search = searchParams.toString();
          for (const internalRscValue of internalRscValues) {
            routeHandlerUrl.searchParams.append(
              VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
              internalRscValue,
            );
          }
          return options.dispatchMatchedRouteHandler({
            cleanPathname: props.cleanPathname,
            middlewareContext,
            params: route.isDynamic ? renderParams : null,
            request: cloneRequestWithUrl(routeHandlerRequest, routeHandlerUrl.toString()),
            route,
            searchParams,
          });
        }

        let pprFallbackCacheShells: AppPagePprFallbackCacheShell[] = [];
        if (
          options.createPprFallbackShells &&
          request.method === "GET" &&
          !normalized.isRscRequest &&
          route.params
        ) {
          pprFallbackCacheShells = options.createPprFallbackShells(
            {
              params: route.params,
              pattern: route.pattern,
              rootParamNames: route.rootParamNames,
            },
            renderParams,
          );
        }

        return options.dispatchMatchedPage({
          bypassInterceptionContextCache: props.bypassInterceptionContextCache,
          clientReuseManifest: normalized.clientReuseManifest,
          cleanPathname: props.cleanPathname,
          displayPathname: props.canonicalPathname,
          formState: null,
          handlerStart: process.env.NODE_ENV !== "production" ? performance.now() : 0,
          interceptionContext: normalized.interceptionContextHeader,
          interceptionId: normalized.interceptionIdHeader,
          interceptionPathname:
            props.matchKind === "resolved" ? props.cleanPathname : normalized.requestCleanPathname,
          isProgressiveActionRender: false,
          isRscRequest: normalized.isRscRequest,
          middlewareContext,
          mountedSlotsHeader: normalized.mountedSlotsHeader,
          params: renderParams,
          pprFallbackCacheShells,
          renderedConcreteUrlPaths: getRenderedConcreteUrlPathsForRoute(route.pattern),
          rootParams,
          request,
          renderedPathAndSearch: props.resolvedUrl,
          route,
          searchParams,
          scriptNonce: props.scriptNonce ?? undefined,
          renderMode: normalized.renderMode,
        });
      },
      { route: () => props.canonicalPathname },
    ),
  );

  let response: Response;
  try {
    response = await responsePromise;
  } catch (error) {
    await closeAfterResponse(requestContext);
    throw error;
  }
  return closeAfterResponseWithBody(response, requestContext);
}
