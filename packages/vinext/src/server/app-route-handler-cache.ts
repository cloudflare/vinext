import type { NextI18nConfig } from "../config/next-config.js";
import type { HeadersAccessPhase } from "vinext/shims/headers";
import { isrCacheControl, type ISRCacheEntry } from "./isr-cache.js";
import type { RouteHandlerMiddlewareContext } from "./app-route-handler-response.js";
import {
  applyRouteHandlerMiddlewareContext,
  assertSupportedAppRouteHandlerResponse,
  buildAppRouteCacheValue,
  buildRouteHandlerCachedResponse,
} from "./app-route-handler-response.js";
import { markKnownDynamicAppRoute } from "./app-route-handler-runtime.js";
import { resolveAppRouteHandlerSpecialError } from "./app-route-handler-policy.js";
import { makeThenableParams } from "vinext/shims/thenable-params";
import {
  runAppRouteHandler,
  traceAppRouteHandlerExecution,
  type AppRouteDebugLogger,
  type AppRouteDynamicUsageFn,
  type AppRouteHandlerFunction,
  type AppRouteParams,
  type MarkAppRouteDynamicUsageFn,
  type RouteHandlerCacheSetter,
} from "./app-route-handler-execution.js";

type RouteHandlerCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type RouteHandlerBackgroundRegenerator = (key: string, renderFn: () => Promise<void>) => void;
type RouteHandlerRevalidationContextRunner = (renderFn: () => Promise<void>) => Promise<void>;

type ReadAppRouteHandlerCacheOptions = {
  basePath?: string;
  buildPageCacheTags: (pathname: string, extraTags: string[]) => string[];
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: AppRouteDynamicUsageFn;
  dynamicConfig?: string;
  getCollectedFetchTags: () => string[];
  handlerFn: AppRouteHandlerFunction;
  i18n?: NextI18nConfig | null;
  trailingSlash?: boolean;
  isAutoHead: boolean;
  appendResponseLink?: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrGet: RouteHandlerCacheGetter;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  markDynamicUsage: MarkAppRouteDynamicUsageFn;
  middlewareContext: RouteHandlerMiddlewareContext;
  /** `null` for non-dynamic routes. See `AppRouteHandlerFunction` for details. */
  params: AppRouteParams | null;
  requestUrl: string;
  revalidateSearchParams: URLSearchParams;
  expireSeconds?: number;
  revalidateSeconds: number;
  routePattern: string;
  runInRevalidationContext: RouteHandlerRevalidationContextRunner;
  scheduleBackgroundRegeneration: RouteHandlerBackgroundRegenerator;
  setHeadersAccessPhase: (phase: HeadersAccessPhase) => HeadersAccessPhase;
  setNavigationContext: (
    context: {
      pathname: string;
      searchParams: URLSearchParams;
      params: AppRouteParams;
    } | null,
  ) => void;
};

// Navigation context expects a plain object (used for `useParams()` etc),
// not `null`. For non-dynamic routes there are no params to expose, so we
// pass an empty object — only the user-visible handler context surfaces
// `null` for non-dynamic routes.
const EMPTY_PARAMS: AppRouteParams = Object.freeze({}) as AppRouteParams;

function getCachedAppRouteValue(entry: ISRCacheEntry | null) {
  return entry?.value.value && entry.value.value.kind === "APP_ROUTE" ? entry.value.value : null;
}

export async function readAppRouteHandlerCacheResponse(
  options: ReadAppRouteHandlerCacheOptions,
): Promise<Response | null> {
  const routeKey = options.isrRouteKey(options.cleanPathname);

  try {
    const cached = await options.isrGet(routeKey);
    const cachedValue = getCachedAppRouteValue(cached);

    if (cached?.isExpired) {
      options.isrDebug?.("MISS (expired route)", options.cleanPathname);
      return null;
    }

    if (cachedValue && !cached?.isStale) {
      options.isrDebug?.("HIT (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(cachedValue, {
          cacheState: "HIT",
          cacheControl: cached?.value.cacheControl,
          expireSeconds: options.expireSeconds,
          isHead: options.isAutoHead,
          revalidateSeconds: options.revalidateSeconds,
        }),
        options.middlewareContext,
        { appendResponseLink: options.appendResponseLink },
      );
    }

    if (cached?.isStale && cachedValue) {
      const staleValue = cachedValue;
      const revalidateSearchParams = new URLSearchParams(options.revalidateSearchParams);

      options.scheduleBackgroundRegeneration(routeKey, () =>
        options.runInRevalidationContext(async () => {
          options.setNavigationContext({
            pathname: options.cleanPathname,
            searchParams: revalidateSearchParams,
            params: options.params ?? EMPTY_PARAMS,
          });

          let tracedResult:
            | { handlerResult: Awaited<ReturnType<typeof runAppRouteHandler>> }
            | { specialError: unknown };
          try {
            tracedResult = await traceAppRouteHandlerExecution(options.routePattern, async () => {
              try {
                return {
                  handlerResult: await runAppRouteHandler({
                    basePath: options.basePath,
                    consumeDynamicUsage: options.consumeDynamicUsage,
                    dynamicConfig: options.dynamicConfig,
                    handlerFn: options.handlerFn,
                    i18n: options.i18n,
                    trailingSlash: options.trailingSlash,
                    markDynamicUsage: options.markDynamicUsage,
                    params: options.params === null ? null : makeThenableParams(options.params),
                    request: new Request(options.requestUrl, { method: "GET" }),
                    routePattern: options.routePattern,
                    setHeadersAccessPhase: options.setHeadersAccessPhase,
                  }),
                };
              } catch (error) {
                if (resolveAppRouteHandlerSpecialError(error, options.requestUrl)) {
                  return { specialError: error };
                }
                throw error;
              }
            });
          } finally {
            options.setNavigationContext(null);
          }
          if ("specialError" in tracedResult) return;

          const { dynamicUsedInHandler, response } = tracedResult.handlerResult;
          assertSupportedAppRouteHandlerResponse(response);

          if (dynamicUsedInHandler) {
            markKnownDynamicAppRoute(options.routePattern);
            options.isrDebug?.("route regen skipped (dynamic usage)", options.cleanPathname);
            return;
          }

          const routeTags = options.buildPageCacheTags(
            options.cleanPathname,
            options.getCollectedFetchTags(),
          );
          const routeCacheValue = await buildAppRouteCacheValue(response);
          await options.isrSet(routeKey, routeCacheValue, {
            cacheControl: isrCacheControl(options.revalidateSeconds, {
              expireSeconds: options.expireSeconds,
            }),
            tags: routeTags,
          });
          options.isrDebug?.("route regen complete", routeKey);
        }),
      );

      options.isrDebug?.("STALE (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(staleValue, {
          cacheState: "STALE",
          cacheControl: cached.value.cacheControl,
          expireSeconds: options.expireSeconds,
          isHead: options.isAutoHead,
          revalidateSeconds: options.revalidateSeconds,
        }),
        options.middlewareContext,
        { appendResponseLink: options.appendResponseLink },
      );
    }
  } catch (routeCacheError) {
    console.error("[vinext] ISR route cache read error:", routeCacheError);
  }

  return null;
}
