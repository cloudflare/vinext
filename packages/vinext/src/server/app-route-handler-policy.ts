import {
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  type RouteHandlerHttpMethod,
  type RouteHandlerModule,
} from "./app-route-handler-runtime.js";
import { parseNextHttpErrorDigest, parseNextRedirectDigest } from "./next-error-digest.js";
export { isPossibleAppRouteActionRequest } from "./app-action-request.js";

export type AppRouteHandlerModule = {
  dynamic?: string;
  dynamicParams?: unknown;
  fetchCache?: unknown;
  generateStaticParams?: unknown;
  revalidate?: unknown;
  runtime?: string;
} & RouteHandlerModule;

type AppRouteHandlerFunction = (...args: unknown[]) => unknown;

type ResolvedAppRouteHandlerMethod = {
  allowHeaderForOptions: string;
  exportedMethods: RouteHandlerHttpMethod[];
  handlerFn: AppRouteHandlerFunction | undefined;
  isAutoHead: boolean;
  shouldAutoRespondToOptions: boolean;
};

type AppRouteHandlerCacheReadOptions = {
  dynamicConfig?: string;
  handlerFn: unknown;
  isAutoHead: boolean;
  isKnownDynamic: boolean;
  isDraftMode?: boolean;
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
};

type AppRouteHandlerResponseCacheOptions = {
  dynamicConfig?: string;
  dynamicUsedInHandler: boolean;
  handlerSetCacheControl: boolean;
  isAutoHead: boolean;
  isDraftMode?: boolean;
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
  responseStatus: number;
};

type AppRouteHandlerSpecialError =
  | {
      kind: "redirect";
      location: string;
      statusCode: number;
    }
  | {
      kind: "status";
      statusCode: number;
    };

type AppRouteHandlerSpecialErrorOptions = {
  isAction: boolean;
};

export function getAppRouteHandlerRevalidateSeconds(
  handler: Pick<AppRouteHandlerModule, "dynamic" | "generateStaticParams" | "revalidate">,
  cacheComponents = false,
): number | null {
  if (cacheComponents) return Infinity;
  // 0 is a meaningful value ("never cache") and must be preserved so the
  // header path can emit a no-store Cache-Control.
  // revalidate = false means "cache indefinitely" (Next.js segment config
  // parity) — return Infinity to signal the cache-later path.
  const { revalidate } = handler;
  if (revalidate === false) return Infinity;
  if (typeof revalidate === "number" && Number.isFinite(revalidate) && revalidate >= 0) {
    return revalidate;
  }
  if (revalidate !== undefined) {
    return null;
  }

  // Next.js statically optimizes App Route handlers only after one of these
  // explicit opt-ins. With no numeric revalidation window, their completed
  // representation is immutable until invalidated or replaced by a deploy.
  // Ported from Next.js:
  // packages/next/src/server/route-modules/app-route/helpers/is-static-gen-enabled.ts
  if (
    handler.dynamic === "force-static" ||
    handler.dynamic === "error" ||
    typeof handler.generateStaticParams === "function"
  ) {
    return Infinity;
  }

  return null;
}

export function assertAppRouteCacheComponentsConfig(
  handler: Pick<AppRouteHandlerModule, "dynamic" | "fetchCache" | "revalidate">,
): void {
  for (const name of ["dynamic", "revalidate", "fetchCache"] as const) {
    if (handler[name] !== undefined) {
      throw new Error(
        `Route segment config "${name}" is not compatible with \`nextConfig.cacheComponents\`. Please remove it.`,
      );
    }
  }
}

export function hasAppRouteHandlerDefaultExport(handler: RouteHandlerModule): boolean {
  return typeof handler.default === "function";
}

export function resolveAppRouteHandlerMethod(
  handler: AppRouteHandlerModule,
  method: string,
): ResolvedAppRouteHandlerMethod {
  const exportedMethods = collectRouteHandlerMethods(handler);
  const allowHeaderForOptions = buildRouteHandlerAllowHeader(exportedMethods);
  const shouldAutoRespondToOptions = method === "OPTIONS" && typeof handler.OPTIONS !== "function";

  let handlerFn =
    typeof handler[method as RouteHandlerHttpMethod] === "function"
      ? (handler[method as RouteHandlerHttpMethod] as AppRouteHandlerFunction)
      : undefined;
  let isAutoHead = false;

  if (
    method === "HEAD" &&
    typeof handler.HEAD !== "function" &&
    typeof handler.GET === "function"
  ) {
    handlerFn = handler.GET as AppRouteHandlerFunction;
    isAutoHead = true;
  }

  return {
    allowHeaderForOptions,
    exportedMethods,
    handlerFn,
    isAutoHead,
    shouldAutoRespondToOptions,
  };
}

export function shouldReadAppRouteHandlerCache(options: AppRouteHandlerCacheReadOptions): boolean {
  // revalidateSeconds === 0 means "never cache" and must skip the ISR read.
  // A previously written entry (e.g. from before the handler opted out)
  // must never be replayed once the author set revalidate = 0.
  return (
    options.isProduction &&
    options.revalidateSeconds !== null &&
    options.revalidateSeconds > 0 &&
    options.dynamicConfig !== "force-dynamic" &&
    !options.isDraftMode &&
    !options.isKnownDynamic &&
    (options.method === "GET" || options.isAutoHead) &&
    typeof options.handlerFn === "function"
  );
}

export function shouldApplyAppRouteHandlerRevalidateHeader(
  options: Omit<AppRouteHandlerResponseCacheOptions, "dynamicConfig" | "isProduction">,
): boolean {
  // Includes revalidateSeconds === 0. That case emits the no-store
  // Cache-Control, which is exactly the header a never-cache handler
  // needs to suppress heuristic caching.
  return (
    (options.responseStatus < 400 || options.responseStatus === 404) &&
    options.revalidateSeconds !== null &&
    !options.isDraftMode &&
    !options.dynamicUsedInHandler &&
    (options.method === "GET" || options.isAutoHead) &&
    !options.handlerSetCacheControl
  );
}

export function shouldWriteAppRouteHandlerCache(
  options: AppRouteHandlerResponseCacheOptions,
): boolean {
  // Excludes revalidateSeconds === 0. A never-cache response must not be
  // persisted to ISR, even though it still needs a Cache-Control header.
  return (
    options.isProduction &&
    options.revalidateSeconds !== null &&
    options.revalidateSeconds > 0 &&
    options.dynamicConfig !== "force-dynamic" &&
    !options.isDraftMode &&
    !options.dynamicUsedInHandler &&
    (options.method === "GET" || options.isAutoHead) &&
    (options.responseStatus < 400 || options.responseStatus === 404)
  );
}

export function resolveAppRouteHandlerSpecialError(
  error: unknown,
  requestUrl: string,
  options?: AppRouteHandlerSpecialErrorOptions,
): AppRouteHandlerSpecialError | null {
  if (!(error && typeof error === "object" && "digest" in error)) {
    return null;
  }

  const digest = String(error.digest);
  const redirect = parseNextRedirectDigest(digest);
  if (redirect) {
    return {
      kind: "redirect",
      location: new URL(redirect.url, requestUrl).toString(),
      statusCode: options?.isAction ? 303 : redirect.status,
    };
  }

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    return {
      kind: "status",
      statusCode: httpError.status,
    };
  }

  return null;
}
