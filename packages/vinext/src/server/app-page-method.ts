import { isPossibleAppRouteActionRequest } from "./app-route-handler-policy.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { methodNotAllowedResponse } from "./http-error-responses.js";

type AppPageMethodPolicyOptions = {
  dynamicConfig?: string;
  hasGenerateStaticParams: boolean;
  isDynamicRoute: boolean;
  revalidateSeconds: number | null;
};

type ResolveAppPageMethodResponseOptions = {
  middlewareHeaders?: Headers | null;
  request: Pick<Request, "headers" | "method">;
} & AppPageMethodPolicyOptions;

function isNonGetOrHead(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
}

export function isStaticOrSsgAppPageCandidate(options: AppPageMethodPolicyOptions): boolean {
  if (options.dynamicConfig === "force-dynamic" || options.revalidateSeconds === 0) {
    return false;
  }

  if (options.dynamicConfig === "force-static" || options.dynamicConfig === "error") {
    return true;
  }

  if (options.revalidateSeconds !== null && options.revalidateSeconds > 0) {
    return true;
  }

  if (options.hasGenerateStaticParams) {
    return true;
  }

  return !options.isDynamicRoute;
}

export function resolveAppPageMethodResponse(
  options: ResolveAppPageMethodResponseOptions,
): Response | null {
  if (!isNonGetOrHead(options.request.method)) {
    return null;
  }

  if (isPossibleAppRouteActionRequest(options.request)) {
    return null;
  }

  if (!isStaticOrSsgAppPageCandidate(options)) {
    return null;
  }

  const headers = new Headers();
  mergeMiddlewareResponseHeaders(headers, options.middlewareHeaders ?? null);

  return methodNotAllowedResponse("GET, HEAD", { headers });
}
