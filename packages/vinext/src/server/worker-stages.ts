import type { PagesRenderOptions } from "./pages-request-pipeline.js";
import type {
  VinextResponseStageDispatchOptions,
  VinextResponseStageTransport,
} from "./multi-stage.js";

export const PAGES_RESPONSE_STAGE_PROTOCOL_VERSION = 3;

type PagesResponseStageEnvelope = {
  buildId: string | null;
  protocolVersion: typeof PAGES_RESPONSE_STAGE_PROTOCOL_VERSION;
  /** Host is explicit because multi-tenant/domain-i18n renders vary by it. */
  requestHost: string;
  /** Outer request-stage headers needed only by non-shared renders. */
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

/** Serializable description of work delegated to a cacheable Worker stage. */
export type WorkerResponseStageProps = PagesApiResponseStageProps | PagesPageResponseStageProps;

/**
 * Host-owned transport for invoking a response stage.
 *
 * Core request pipelines decide what may be shared and provide only body
 * identity here. Response-only middleware/config state remains in the caller
 * and is composed after this promise resolves.
 */
export type DispatchWorkerResponseStage = VinextResponseStageTransport<WorkerResponseStageProps>;

/** Normalize cacheable HEAD requests onto the GET representation. */
export function prepareResponseStageDispatch(
  request: Request,
  cache: VinextResponseStageDispatchOptions["cache"],
): Request {
  return cache !== "bypass" && request.method.toUpperCase() === "HEAD"
    ? new Request(request, { method: "GET" })
    : request;
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

export function isPagesResponseStageProps(value: unknown): value is WorkerResponseStageProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Partial<WorkerResponseStageProps>;
  if (
    props.protocolVersion !== PAGES_RESPONSE_STAGE_PROTOCOL_VERSION ||
    (props.buildId !== null && typeof props.buildId !== "string") ||
    typeof props.requestHost !== "string" ||
    props.requestHost.length === 0 ||
    (props.stagedHeaders !== null && !isSerializedHeaders(props.stagedHeaders))
  ) {
    return false;
  }
  if (props.kind === "pages-api") return typeof props.apiUrl === "string";
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
