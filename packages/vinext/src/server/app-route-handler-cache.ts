import type { NextI18nConfig } from "../config/next-config.js";
import type { HeadersAccessPhase } from "vinext/shims/headers";
import type { CachedRouteValue } from "vinext/shims/cache";
import type { ISRCacheEntry } from "./isr-cache.js";
import type { RouteHandlerMiddlewareContext } from "./app-route-handler-response.js";
import {
  applyRouteHandlerMiddlewareContext,
  assertSupportedAppRouteHandlerResponse,
  buildAppRouteCacheValue,
  buildRouteHandlerCachedResponse,
  preventSharedRouteHandlerCaching,
} from "./app-route-handler-response.js";
import { markKnownDynamicAppRoute } from "./app-route-handler-runtime.js";
import { makeThenableParams } from "vinext/shims/thenable-params";
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
type RouteHandlerCacheDeleter = (key: string) => Promise<void>;
type RouteHandlerBackgroundRegenerator = (key: string, renderFn: () => Promise<void>) => void;
type RouteHandlerRevalidationContextRunner = (renderFn: () => Promise<void>) => Promise<void>;

type ReadAppRouteHandlerCacheOptions = {
  basePath?: string;
  buildPageCacheTags: (pathname: string, extraTags: string[]) => string[];
  cleanPathname: string;
  clearRequestContext: () => void;
  consumeDynamicUsage: AppRouteDynamicUsageFn;
  dynamicConfig?: string;
  getAndClearPendingCookies: () => string[];
  getCollectedFetchTags: () => string[];
  getDraftModeCookieHeader: () => string | null | undefined;
  handlerFn: AppRouteHandlerFunction;
  i18n?: NextI18nConfig | null;
  trailingSlash?: boolean;
  isAutoHead: boolean;
  isrDebug?: AppRouteDebugLogger;
  isrDelete: RouteHandlerCacheDeleter;
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

function hasCachedSetCookie(value: CachedRouteValue): boolean {
  return Object.keys(value.headers).some((key) => key.toLowerCase() === "set-cookie");
}

function applyCachedRouteHandlerMiddlewareContext(
  response: Response,
  middlewareContext: RouteHandlerMiddlewareContext,
): Response {
  const finalizedResponse = applyRouteHandlerMiddlewareContext(response, middlewareContext);
  return finalizedResponse.headers.has("set-cookie")
    ? preventSharedRouteHandlerCaching(finalizedResponse)
    : finalizedResponse;
}

export async function readAppRouteHandlerCacheResponse(
  options: ReadAppRouteHandlerCacheOptions,
): Promise<Response | null> {
  const routeKey = options.isrRouteKey(options.cleanPathname);

  try {
    const cached = await options.isrGet(routeKey);
    const cachedValue = getCachedAppRouteValue(cached);

    if (cachedValue && hasCachedSetCookie(cachedValue)) {
      await options.isrDelete(routeKey);
      options.isrDebug?.("invalid route cache deleted (set-cookie)", routeKey);
      return null;
    }

    if (cachedValue && !cached?.isStale) {
      options.isrDebug?.("HIT (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyCachedRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(cachedValue, {
          cacheState: "HIT",
          cacheControl: cached?.value.cacheControl,
          expireSeconds: options.expireSeconds,
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
            params: options.params ?? EMPTY_PARAMS,
          });

          const { dynamicUsedInHandler, response } = await runAppRouteHandler({
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
          });

          options.setNavigationContext(null);
          assertSupportedAppRouteHandlerResponse(response);

          const pendingCookies = options.getAndClearPendingCookies();
          const hasResponseCookies =
            response.headers.has("set-cookie") ||
            pendingCookies.length > 0 ||
            Boolean(options.getDraftModeCookieHeader()) ||
            options.middlewareContext.headers?.has("set-cookie") === true;

          if (dynamicUsedInHandler || hasResponseCookies) {
            markKnownDynamicAppRoute(options.routePattern);
            options.isrDebug?.(
              hasResponseCookies
                ? "route regen skipped (response cookies)"
                : "route regen skipped (dynamic usage)",
              options.cleanPathname,
            );
            return;
          }

          const routeTags = options.buildPageCacheTags(
            options.cleanPathname,
            options.getCollectedFetchTags(),
          );
          const routeCacheValue = await buildAppRouteCacheValue(response);
          await options.isrSet(
            routeKey,
            routeCacheValue,
            options.revalidateSeconds,
            routeTags,
            options.expireSeconds,
          );
          options.isrDebug?.("route regen complete", routeKey);
        });
      });

      options.isrDebug?.("STALE (route)", options.cleanPathname);
      options.clearRequestContext();
      return applyCachedRouteHandlerMiddlewareContext(
        buildRouteHandlerCachedResponse(staleValue, {
          cacheState: "STALE",
          cacheControl: cached.value.cacheControl,
          expireSeconds: options.expireSeconds,
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
