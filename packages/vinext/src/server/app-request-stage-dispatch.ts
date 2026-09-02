import { isDraftModeRequest } from "vinext/shims/headers";
import { isRouteTreePrefetchRequest } from "./app-route-tree-prefetch.js";
import type { AppRscRequestHandler } from "./app-rsc-handler.js";
import {
  APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  type DispatchAppWorkerResponseStage,
} from "./app-worker-stages.js";
import { getScriptNonceFromHeaderSources } from "./csp.js";
import { VINEXT_PRERENDER_ROUTE_PARAMS_HEADER } from "./headers.js";
import type { VinextCacheabilityProbeMode } from "./multi-stage.js";
import { restoreStaticFileSignalFromTransport } from "./static-file-signal.js";

export type AppRequestStageDispatchOptions = {
  basePath: string;
  buildId: string | null;
  draftModeSecret: string;
  handleRequest: AppRscRequestHandler;
  prerenderDiscovery: boolean;
  probeMode: VinextCacheabilityProbeMode | null;
};

/**
 * Whether this request needs the complete App response graph before ordinary
 * request-stage routing can safely classify it.
 */
export function appRequestUsesFullResponseGraph(
  request: Request,
  options: Pick<AppRequestStageDispatchOptions, "basePath" | "draftModeSecret" | "probeMode">,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return true;
  if (
    request.headers
      .get("upgrade")
      ?.split(",")
      .some((value) => value.trim().toLowerCase() === "websocket")
  ) {
    return true;
  }
  if (process.env.VINEXT_PRERENDER === "1") return true;
  if (isDraftModeRequest(request, options.draftModeSecret)) return true;
  if (request.headers.has(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER)) return true;

  const cacheControl = request.headers.get("cache-control")?.toLowerCase() ?? "";
  if (
    !options.probeMode &&
    /(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:,|$)|\s*=)/.test(cacheControl)
  ) {
    return true;
  }
  if (
    getScriptNonceFromHeaderSources(request.headers) !== undefined ||
    isRouteTreePrefetchRequest(request)
  ) {
    return true;
  }

  const url = new URL(request.url);
  const pathname =
    options.basePath && url.pathname.startsWith(options.basePath + "/")
      ? url.pathname.slice(options.basePath.length)
      : url.pathname;
  return pathname.startsWith("/__vinext/");
}

/**
 * Select the request-only or complete App graph and perform the transport
 * bookkeeping needed by a full-stage dispatch.
 */
export async function dispatchAppRequestStage(
  request: Request,
  ctx: unknown,
  dispatchResponseStage: DispatchAppWorkerResponseStage | null | undefined,
  options: AppRequestStageDispatchOptions,
): Promise<Response> {
  if (!dispatchResponseStage) {
    throw new Error("App request stage requires a response-stage dispatcher");
  }
  if (appRequestUsesFullResponseGraph(request, options)) {
    const staticFileSignalToken = crypto.randomUUID();
    const response = await dispatchResponseStage(
      request,
      {
        kind: "app-full-request",
        buildId: options.buildId,
        cacheability: {
          policyHeaders: null,
          probeMode: options.probeMode,
          resolvedRoutePathname: new URL(request.url).pathname,
        },
        draftModeCookie: null,
        middlewareCookieOverlay: null,
        prerenderDiscovery: options.prerenderDiscovery,
        protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
        scriptNonce: null,
        staticFileSignalToken,
      },
      { cache: "bypass" },
    );
    return restoreStaticFileSignalFromTransport(response, staticFileSignalToken);
  }
  return options.handleRequest(request, ctx, false, dispatchResponseStage, options.probeMode);
}
