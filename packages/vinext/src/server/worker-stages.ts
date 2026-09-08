import type { PagesRenderOptions } from "./pages-request-pipeline.js";
import type {
  VinextResponseStageCacheability,
  VinextResponseStageTransport,
} from "./multi-stage.js";

export const PAGES_RESPONSE_STAGE_PROTOCOL_VERSION = 4;
export const PAGES_RESPONSE_STAGE_POLICY_OWNER_HEADER =
  "x-vinext-pages-response-stage-policy-owner";
export type PagesResponseStagePolicyOwner = "request-time" | "static";

type PagesResponseStageEnvelope = {
  buildId: string | null;
  cacheability: VinextResponseStageCacheability;
  protocolVersion: typeof PAGES_RESPONSE_STAGE_PROTOCOL_VERSION;
  /** Host is explicit because multi-tenant/domain-i18n renders vary by it. */
  requestHost: string;
  /** Complete response-header snapshot installed before Pages user code runs. */
  stagedHeaders: Array<[string, string]> | null;
};

/** Serializable Pages page render delegated to a cacheable Worker stage. */
type PagesPageResponseStageProps = PagesResponseStageEnvelope & {
  kind: "pages-page";
  renderOptions: PagesRenderOptions | null;
  resolvedUrl: string;
};

/** Serializable Pages API dispatch delegated to a cacheable Worker stage. */
type PagesApiResponseStageProps = PagesResponseStageEnvelope & {
  apiUrl: string;
  kind: "pages-api";
};

/** Authenticated staged-worker path discovery delegated outside the shared cache. */
type PagesPrerenderDiscoveryStageProps = PagesResponseStageEnvelope & {
  kind: "pages-prerender-discovery";
};

/** Serializable description of work delegated to a cacheable Worker stage. */
export type WorkerResponseStageProps =
  | PagesApiResponseStageProps
  | PagesPageResponseStageProps
  | PagesPrerenderDiscoveryStageProps;

/**
 * Host-owned transport for invoking a response stage.
 *
 * Core request pipelines decide what may be shared and provide the complete
 * serialized render identity here. Response-only middleware/config state is
 * carried in the props so Pages user code observes the same pre-handler
 * response as Next.js.
 */
export type DispatchWorkerResponseStage = VinextResponseStageTransport<WorkerResponseStageProps>;

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

export function isPagesResponseStageProps(value: unknown): value is WorkerResponseStageProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Partial<WorkerResponseStageProps>;
  if (
    props.protocolVersion !== PAGES_RESPONSE_STAGE_PROTOCOL_VERSION ||
    (props.buildId !== null && typeof props.buildId !== "string") ||
    !isResponseStageCacheability(props.cacheability) ||
    typeof props.requestHost !== "string" ||
    props.requestHost.length === 0 ||
    (props.stagedHeaders !== null && !isSerializedHeaders(props.stagedHeaders))
  ) {
    return false;
  }
  if (props.kind === "pages-api") return typeof props.apiUrl === "string";
  if (props.kind === "pages-prerender-discovery") return true;
  if (props.kind !== "pages-page" || typeof props.resolvedUrl !== "string") return false;
  if (props.renderOptions === null) return true;
  if (!props.renderOptions || typeof props.renderOptions !== "object") return false;
  const options = props.renderOptions;
  return (
    (options.isDataReq === undefined || typeof options.isDataReq === "boolean") &&
    (options.renderErrorPageOnMiss === undefined ||
      typeof options.renderErrorPageOnMiss === "boolean") &&
    (options.originalUrl === undefined || typeof options.originalUrl === "string")
  );
}
