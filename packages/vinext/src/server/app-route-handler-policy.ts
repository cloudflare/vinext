import {
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  type RouteHandlerHttpMethod,
  type RouteHandlerModule,
} from "./app-route-handler-runtime.js";

export type AppRouteHandlerModule = {
  dynamic?: string;
  revalidate?: unknown;
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
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
};

type AppRouteHandlerResponseCacheOptions = {
  dynamicConfig?: string;
  dynamicUsedInHandler: boolean;
  handlerSetCacheControl: boolean;
  isAutoHead: boolean;
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
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

export function isPossibleAppRouteActionRequest(
  request: Pick<Request, "headers" | "method">,
): boolean {
  if (request.method.toUpperCase() !== "POST") return false;

  const contentType = request.headers.get("content-type");
  return (
    request.headers.has("x-rsc-action") ||
    request.headers.has("next-action") ||
    // Next.js uses strict equality here, so charset variants intentionally do
    // not classify as action requests even though they are valid form posts.
    contentType === "application/x-www-form-urlencoded" ||
    contentType?.startsWith("multipart/form-data") === true
  );
}

export function getAppRouteHandlerRevalidateSeconds(
  handler: Pick<AppRouteHandlerModule, "revalidate">,
): number | null {
  // 0 is a meaningful value ("never cache") and must be preserved so the
  // header path can emit a no-store Cache-Control.
  // revalidate = false means "cache indefinitely" (Next.js segment config
  // parity) — return Infinity to signal the cache-later path.
  const { revalidate } = handler;
  if (revalidate === false) return Infinity;
  if (typeof revalidate !== "number" || !Number.isFinite(revalidate) || revalidate < 0) {
    return null;
  }
  return revalidate;
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
    options.revalidateSeconds !== Infinity &&
    options.dynamicConfig !== "force-dynamic" &&
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
    options.revalidateSeconds !== null &&
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
    options.revalidateSeconds !== Infinity &&
    options.dynamicConfig !== "force-dynamic" &&
    shouldApplyAppRouteHandlerRevalidateHeader(options)
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
  if (digest.startsWith("NEXT_REDIRECT;")) {
    const parts = digest.split(";");
    const redirectUrl = decodeURIComponent(parts[2]);
    return {
      kind: "redirect",
      location: new URL(redirectUrl, requestUrl).toString(),
      statusCode: options?.isAction ? 303 : parts[3] ? parseInt(parts[3], 10) : 307,
    };
  }

  if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
    return {
      kind: "status",
      statusCode: digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10),
    };
  }

  return null;
}
