import type { AppRscRenderMode } from "./app-rsc-render-mode.js";
import type {
  VinextResponseStageCacheability,
  VinextResponseStageDispatchOptions,
  VinextResponseStageTransport,
} from "./multi-stage.js";
import { isTrustedPrerenderState, type TrustedPrerenderState } from "./prerender-route-params.js";

export const APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION = 7;
export const APP_METADATA_RESPONSE_STAGE_NO_MATCH_HEADER = "x-vinext-app-metadata-stage-no-match";
const STATIC_FILE_SIGNAL_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AppPageParams = Record<string, string | string[]>;

type AppWorkerResponseStageEnvelope = {
  buildId: string | null;
  cacheability: VinextResponseStageCacheability;
  draftModeCookie: string | null;
  middlewareCookieOverlay: string | null;
  protocolVersion: typeof APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION;
  /** Canonical public request origin used to partition and validate shared renders. */
  requestOrigin: string;
  scriptNonce: string | null;
};

type AppFullRequestWorkerResponseStageProps = AppWorkerResponseStageEnvelope & {
  kind: "app-full-request";
  prerenderDiscovery: boolean;
  staticFileSignalToken: string;
  trustedPrerenderState: TrustedPrerenderState | null;
};

export type AppMatchedWorkerResponseStageProps = AppWorkerResponseStageEnvelope & {
  kind: "app-page" | "app-route-handler";
  bypassInterceptionContextCache: boolean;
  canonicalPathname: string;
  cleanPathname: string;
  interceptionContext: string | null;
  interceptionId: string | null;
  isRscRequest: boolean;
  matchKind: "interception" | "request" | "resolved";
  mountedSlotsHeader: string | null;
  params: AppPageParams;
  resolvedUrl: string;
  routePattern: string;
  routePathname: string;
  renderMode: AppRscRenderMode;
};

type AppNotFoundWorkerResponseStageProps = AppWorkerResponseStageEnvelope & {
  kind: "app-not-found";
  canonicalPathname: string;
  cleanPathname: string;
  isRscRequest: boolean;
  mountedSlotsHeader: string | null;
  renderMode: AppRscRenderMode;
  resolvedUrl: string;
};

type AppMetadataWorkerResponseStageProps = AppWorkerResponseStageEnvelope & {
  kind: "app-metadata";
  canonicalPathname: string;
  cleanPathname: string;
  isRscRequest: boolean;
  mountedSlotsHeader: string | null;
  renderMode: AppRscRenderMode;
  resolvedUrl: string;
};

type HybridPagesWorkerResponseStageProps = AppWorkerResponseStageEnvelope & {
  kind: "hybrid-pages";
  allowRscDocumentFallback: boolean;
  appRouteMatch: {
    isDynamic: boolean;
    pattern: string;
  } | null;
  canonicalPathname: string;
  cleanPathname: string;
  isDataRequest: boolean;
  isRscRequest: boolean;
  matchKind: "dynamic" | "static";
  /** Complete response-header snapshot installed before request-time Pages user code runs. */
  preHandlerHeaders: Array<[string, string]> | null;
  resourceKind: "api" | "page";
  requestUrl: string;
  resolvedUrl: string;
};

export type AppWorkerResponseStageProps =
  | AppFullRequestWorkerResponseStageProps
  | AppMatchedWorkerResponseStageProps
  | AppMetadataWorkerResponseStageProps
  | AppNotFoundWorkerResponseStageProps
  | HybridPagesWorkerResponseStageProps;

export type DispatchAppWorkerResponseStage =
  VinextResponseStageTransport<AppWorkerResponseStageProps>;

export type RenderAppWorkerResponseStageLocally = (
  request: Request,
  props: AppWorkerResponseStageProps,
) => Promise<Response>;

/** Normalize a shared App page HEAD request onto its method-invariant GET representation. */
export function prepareSharedAppPageDispatch(
  request: Request,
  cache: VinextResponseStageDispatchOptions["cache"],
): Request {
  return cache !== "bypass" && request.method.toUpperCase() === "HEAD"
    ? new Request(request, { method: "GET" })
    : request;
}

function isAppPageParams(value: unknown): value is AppPageParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const param of Object.values(value)) {
    if (typeof param === "string") continue;
    if (!Array.isArray(param) || param.some((item) => typeof item !== "string")) return false;
  }
  return true;
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

export function isAppWorkerResponseStageProps(
  value: unknown,
): value is AppWorkerResponseStageProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Partial<AppWorkerResponseStageProps>;
  if (
    props.protocolVersion !== APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION ||
    (props.buildId !== null && typeof props.buildId !== "string") ||
    !isResponseStageCacheability(props.cacheability) ||
    (props.draftModeCookie !== null && typeof props.draftModeCookie !== "string") ||
    (props.middlewareCookieOverlay !== null && typeof props.middlewareCookieOverlay !== "string") ||
    !isCanonicalHttpOrigin(props.requestOrigin) ||
    (props.scriptNonce !== null && typeof props.scriptNonce !== "string")
  ) {
    return false;
  }
  if (props.kind === "app-full-request") {
    return (
      typeof props.prerenderDiscovery === "boolean" &&
      typeof props.staticFileSignalToken === "string" &&
      STATIC_FILE_SIGNAL_TOKEN_RE.test(props.staticFileSignalToken) &&
      (props.trustedPrerenderState === null || isTrustedPrerenderState(props.trustedPrerenderState))
    );
  }
  if (props.kind === "hybrid-pages") {
    const hybrid = props as Partial<HybridPagesWorkerResponseStageProps>;
    const appRouteMatch = hybrid.appRouteMatch;
    return (
      typeof hybrid.allowRscDocumentFallback === "boolean" &&
      (appRouteMatch === null ||
        (typeof appRouteMatch === "object" &&
          typeof appRouteMatch.isDynamic === "boolean" &&
          typeof appRouteMatch.pattern === "string" &&
          appRouteMatch.pattern.startsWith("/"))) &&
      typeof hybrid.canonicalPathname === "string" &&
      hybrid.canonicalPathname.startsWith("/") &&
      typeof hybrid.cleanPathname === "string" &&
      hybrid.cleanPathname.startsWith("/") &&
      typeof hybrid.isDataRequest === "boolean" &&
      typeof hybrid.isRscRequest === "boolean" &&
      (hybrid.matchKind === "dynamic" || hybrid.matchKind === "static") &&
      (hybrid.preHandlerHeaders === null || isSerializedHeaders(hybrid.preHandlerHeaders)) &&
      (hybrid.resourceKind === "api" || hybrid.resourceKind === "page") &&
      typeof hybrid.requestUrl === "string" &&
      typeof hybrid.resolvedUrl === "string" &&
      hybrid.resolvedUrl.startsWith("/")
    );
  }
  if (props.kind === "app-metadata" || props.kind === "app-not-found") {
    const special = props as Partial<
      AppMetadataWorkerResponseStageProps | AppNotFoundWorkerResponseStageProps
    >;
    return (
      typeof special.canonicalPathname === "string" &&
      special.canonicalPathname.startsWith("/") &&
      typeof special.cleanPathname === "string" &&
      special.cleanPathname.startsWith("/") &&
      typeof special.isRscRequest === "boolean" &&
      (special.mountedSlotsHeader === null || typeof special.mountedSlotsHeader === "string") &&
      typeof special.resolvedUrl === "string" &&
      special.resolvedUrl.startsWith("/") &&
      (special.renderMode === "navigation" ||
        special.renderMode === "prefetch-empty" ||
        special.renderMode === "prefetch-dynamic-shell" ||
        special.renderMode === "prefetch-loading-shell")
    );
  }
  return (
    (props.kind === "app-page" || props.kind === "app-route-handler") &&
    typeof props.bypassInterceptionContextCache === "boolean" &&
    typeof props.canonicalPathname === "string" &&
    props.canonicalPathname.startsWith("/") &&
    typeof props.cleanPathname === "string" &&
    props.cleanPathname.startsWith("/") &&
    (props.interceptionContext === null || typeof props.interceptionContext === "string") &&
    (props.interceptionId === null || typeof props.interceptionId === "string") &&
    typeof props.isRscRequest === "boolean" &&
    (props.matchKind === "interception" ||
      props.matchKind === "request" ||
      props.matchKind === "resolved") &&
    (props.mountedSlotsHeader === null || typeof props.mountedSlotsHeader === "string") &&
    isAppPageParams(props.params) &&
    typeof props.resolvedUrl === "string" &&
    props.resolvedUrl.startsWith("/") &&
    typeof props.routePattern === "string" &&
    props.routePattern.startsWith("/") &&
    typeof props.routePathname === "string" &&
    props.routePathname.startsWith("/") &&
    (props.renderMode === "navigation" ||
      props.renderMode === "prefetch-empty" ||
      props.renderMode === "prefetch-dynamic-shell" ||
      props.renderMode === "prefetch-loading-shell")
  );
}

function isSerializedHeaders(value: unknown): value is Array<[string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function isResponseStageCacheability(value: unknown): value is VinextResponseStageCacheability {
  if (!value || typeof value !== "object") return false;
  const cacheability = value as Partial<VinextResponseStageCacheability>;
  return (
    (cacheability.probeMode === null ||
      cacheability.probeMode === "probe" ||
      cacheability.probeMode === "identity") &&
    (cacheability.policyHeaders === null ||
      (Array.isArray(cacheability.policyHeaders) &&
        cacheability.policyHeaders.every(
          (entry) =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string",
        ))) &&
    (cacheability.representation === undefined ||
      cacheability.representation === "app-route" ||
      cacheability.representation === "html" ||
      cacheability.representation === "pages-data" ||
      cacheability.representation === "rsc-full" ||
      cacheability.representation === "rsc-loading-shell") &&
    typeof cacheability.resolvedRoutePathname === "string" &&
    cacheability.resolvedRoutePathname.startsWith("/")
  );
}
