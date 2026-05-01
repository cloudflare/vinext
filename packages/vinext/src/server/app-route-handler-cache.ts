import type { NextI18nConfig } from "../config/next-config.js";
import type { HeadersAccessPhase } from "vinext/shims/headers";
import type { ISRCacheEntry } from "./isr-cache.js";
import type { RouteHandlerMiddlewareContext } from "./app-route-handler-response.js";
import {
  applyRouteHandlerMiddlewareContext,
  assertSupportedAppRouteHandlerResponse,
  buildAppRouteCacheValue,
  buildRouteHandlerCachedResponse,
} from "./app-route-handler-response.js";
import { markKnownDynamicAppRoute } from "./app-route-handler-runtime.js";
import {
  runAppRouteHandler,
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
  isAutoHead: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrGet: RouteHandlerCacheGetter;
  isrRouteKey: (pathname: string) => string;
  isrSet: RouteHandlerCacheSetter;
  markDynamicUsage: MarkAppRouteDynamicUsageFn;
  middlewareContext: RouteHandlerMiddlewareContext;
  params: AppRouteParams;
  requestUrl: string;
  revalidateSearchParams: URLSearchParams;
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

    if (cachedValue && !cached?.isStale) {
      options.isrDebug?.("HIT (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(cachedValue, {
          cacheState: "HIT",
          isHead: options.isAutoHead,
          revalidateSeconds: options.revalidateSeconds,
        }),
        options.middlewareContext,
      );
    }

    if (cached?.isStale && cachedValue) {
      const staleValue = cachedValue;
      const revalidateSearchParams = new URLSearchParams(options.revalidateSearchParams);

      options.scheduleBackgroundRegeneration(routeKey, async () => {
        await options.runInRevalidationContext(async () => {
          options.setNavigationContext({
            pathname: options.cleanPathname,
            searchParams: revalidateSearchParams,
            params: options.params,
          });

          const { dynamicUsedInHandler, response } = await runAppRouteHandler({
            basePath: options.basePath,
            consumeDynamicUsage: options.consumeDynamicUsage,
            dynamicConfig: options.dynamicConfig,
            handlerFn: options.handlerFn,
            i18n: options.i18n,
            markDynamicUsage: options.markDynamicUsage,
            params: options.params,
            request: new Request(options.requestUrl, { method: "GET" }),
            routePattern: options.routePattern,
            setHeadersAccessPhase: options.setHeadersAccessPhase,
          });

          options.setNavigationContext(null);
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
          await options.isrSet(routeKey, routeCacheValue, options.revalidateSeconds, routeTags);
          options.isrDebug?.("route regen complete", routeKey);
        });
      });

      options.isrDebug?.("STALE (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(staleValue, {
          cacheState: "STALE",
          isHead: options.isAutoHead,
          revalidateSeconds: options.revalidateSeconds,
        }),
        options.middlewareContext,
      );
    }
  } catch (routeCacheError) {
    console.error("[vinext] ISR route cache read error:", routeCacheError);
  }

  return null;
}
