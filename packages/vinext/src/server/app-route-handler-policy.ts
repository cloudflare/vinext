import {
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  type RouteHandlerHttpMethod,
  type RouteHandlerModule,
} from "./app-route-handler-runtime.js";

export interface AppRouteHandlerModule extends RouteHandlerModule {
  dynamic?: string;
  revalidate?: unknown;
}

type AppRouteHandlerFunction = (...args: unknown[]) => unknown;

export interface ResolvedAppRouteHandlerMethod {
  allowHeaderForOptions: string;
  exportedMethods: RouteHandlerHttpMethod[];
  handlerFn: AppRouteHandlerFunction | undefined;
  isAutoHead: boolean;
  shouldAutoRespondToOptions: boolean;
}

export interface AppRouteHandlerCacheReadOptions {
  dynamicConfig?: string;
  handlerFn: unknown;
  isAutoHead: boolean;
  isKnownDynamic: boolean;
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
}

export interface AppRouteHandlerResponseCacheOptions {
  dynamicConfig?: string;
  dynamicUsedInHandler: boolean;
  handlerSetCacheControl: boolean;
  isAutoHead: boolean;
  isProduction: boolean;
  method: string;
  revalidateSeconds: number | null;
}

export type AppRouteHandlerSpecialError =
  | {
      kind: "redirect";
      location: string;
      statusCode: number;
    }
  | {
      kind: "status";
      statusCode: number;
    };

export function getAppRouteHandlerRevalidateSeconds(
  handler: Pick<AppRouteHandlerModule, "revalidate">,
): number | null {
  return typeof handler.revalidate === "number" &&
    handler.revalidate > 0 &&
    handler.revalidate !== Infinity
    ? handler.revalidate
    : null;
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
  return (
    options.isProduction &&
    options.revalidateSeconds !== null &&
    options.dynamicConfig !== "force-dynamic" &&
    !options.isKnownDynamic &&
    (options.method === "GET" || options.isAutoHead) &&
    typeof options.handlerFn === "function"
  );
}

export function shouldApplyAppRouteHandlerRevalidateHeader(
  options: Omit<AppRouteHandlerResponseCacheOptions, "dynamicConfig" | "isProduction">,
): boolean {
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
  return (
    options.isProduction &&
    options.revalidateSeconds !== null &&
    options.dynamicConfig !== "force-dynamic" &&
    shouldApplyAppRouteHandlerRevalidateHeader(options)
  );
}

export function resolveAppRouteHandlerSpecialError(
  error: unknown,
  requestUrl: string,
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
      statusCode: parts[3] ? parseInt(parts[3], 10) : 307,
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
