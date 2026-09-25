/**
 * Build-internal channel carrying a prerendered App page's render
 * observations from the prerender server to `build/prerender.ts`, which stores
 * them in `vinext-prerender.json` for the seed readers.
 *
 * The observations are only final once the render has finished, after the
 * response headers are sent, so they travel as a private marker appended to
 * the end of the prerender's HTML body. Response headers can't carry them:
 * two observations with their tags can pass the HTTP client's header limit.
 *
 * The prerender sends a fresh random nonce with each page request
 * (`VINEXT_PRERENDER_OBSERVATION_NONCE_HEADER`), and the marker carries it.
 * Request boundaries move the nonce off the request into the trusted
 * prerender state, so middleware and userland never see it, and only the
 * renderer can frame a marker with it. The prerender strips only a marker
 * with its own nonce and a valid payload, before the HTML is written or read
 * in any other way, so HTML that didn't come from the App renderer (a
 * middleware response, say) is never mistaken for the channel, whatever it
 * ends with. Only prerender servers (`VINEXT_PRERENDER=1`) append the marker,
 * and only for a request that sent a nonce.
 */
import {
  ALL_RENDER_REQUEST_API_KINDS,
  CACHE_PROOF_MODEL_SCHEMA_VERSION,
  isCacheProofFallbackMode,
  isCacheProofFallbackScope,
  isCacheProofRejectionCode,
  type BoundaryOutcome,
  type CacheProofDowngradeReason,
  type CacheProofDowngradeTarget,
  type RenderCacheability,
  type RenderObservation,
  type RenderObservationCompleteness,
  type RenderRequestApiStatus,
} from "./cache-proof.js";
import { isUnknownRecord } from "../utils/record.js";
import { isPrerenderObservationNonce } from "./prerender-route-params.js";

export { isPrerenderObservationNonce };

/** The observations of a prerendered App page's render, one per stored artifact. */
export type PrerenderRenderObservations = {
  html: RenderObservation;
  rsc: RenderObservation;
};

const MARKER_PREFIX = "<!--vinext-prerender-render-observations:";
const MARKER_SUFFIX = "-->";
// encodeURIComponent output, so a match can't span other markup.
const ENCODED_PAYLOAD = /^[A-Za-z0-9\-_.!~*'()%]*$/;

/** A fresh nonce for one prerender page request. */
export function createPrerenderObservationNonce(): string {
  return crypto.randomUUID();
}

/**
 * Append the observations, framed with the request's nonce, to the end of a
 * prerender's HTML stream once the upstream has closed and the observations
 * have settled. `null` appends nothing.
 *
 * `observe` gets a promise that resolves once the upstream HTML has closed:
 * HTML consumption can still run render code (`useServerInsertedHTML`
 * callbacks, say), so the observations must wait for it. `observe` is called
 * now, not from `flush`, so its continuations run in the caller's request
 * context rather than the stream consumer's.
 */
export function appendPrerenderRenderObservations(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
  observe: (upstreamClosed: Promise<void>) => Promise<PrerenderRenderObservations | null>,
): ReadableStream<Uint8Array> {
  let closeUpstream!: () => void;
  const observations = observe(
    new Promise<void>((resolve) => {
      closeUpstream = resolve;
    }),
  );
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush(controller) {
        closeUpstream();
        const settled = await observations;
        if (!settled) return;
        controller.enqueue(
          new TextEncoder().encode(
            `${MARKER_PREFIX}${nonce}:${encodeURIComponent(JSON.stringify(settled))}${MARKER_SUFFIX}`,
          ),
        );
      },
    }),
  );
}

/**
 * Split a prerendered HTML body into the document and the observations the
 * render appended for the request that sent `nonce`. A body that doesn't end
 * with that request's marker, carrying valid observations, keeps every byte
 * and has no observations.
 */
export function extractPrerenderRenderObservations(
  body: string,
  nonce: string,
): {
  html: string;
  renderObservations: PrerenderRenderObservations | null;
} {
  const unchanged = { html: body, renderObservations: null };
  if (!isPrerenderObservationNonce(nonce) || !body.endsWith(MARKER_SUFFIX)) return unchanged;
  const prefix = `${MARKER_PREFIX}${nonce}:`;
  const start = body.lastIndexOf(prefix);
  if (start === -1) return unchanged;
  const payload = body.slice(start + prefix.length, body.length - MARKER_SUFFIX.length);
  if (!ENCODED_PAYLOAD.test(payload)) return unchanged;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(payload));
  } catch {
    return unchanged;
  }
  if (!isPrerenderRenderObservations(parsed)) return unchanged;
  return { html: body.slice(0, start), renderObservations: parsed };
}

export function isPrerenderRenderObservations(
  value: unknown,
): value is PrerenderRenderObservations {
  if (!isUnknownRecord(value)) return false;
  return isRenderObservation(value.html, "app-html") && isRenderObservation(value.rsc, "app-rsc");
}

const RENDER_OBSERVATION_COMPLETENESS: ReadonlySet<unknown> =
  new Set<RenderObservationCompleteness>(["complete", "partial", "unknown"]);
const RENDER_REQUEST_API_KINDS: ReadonlySet<unknown> = new Set(ALL_RENDER_REQUEST_API_KINDS);
const RENDER_REQUEST_API_STATUSES: ReadonlySet<unknown> = new Set<RenderRequestApiStatus>([
  "notObserved",
  "observed",
  "unknown",
]);
const RENDER_CACHEABILITY: ReadonlySet<unknown> = new Set<RenderCacheability>([
  "private",
  "public",
  "uncacheable",
  "unknown",
]);
const DOWNGRADE_TARGETS: ReadonlySet<unknown> = new Set<CacheProofDowngradeTarget>([
  "freshRender",
  "private",
  "privateUncacheable",
  "public",
  "publicVariant",
]);
const BOUNDARY_OUTCOME_KINDS: ReadonlySet<unknown> = new Set<BoundaryOutcome["kind"]>([
  "error",
  "forbidden",
  "globalError",
  "notFound",
  "redirect",
  "success",
  "unauthorized",
  "unknown",
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/**
 * Whether `value` is a complete render observation of this proof model's
 * schema for the prerender's `outputKind` artifact. The manifest is untyped
 * input: anything else, including an observation from another schema version,
 * yields no proof instead of a seed, and never throws.
 */
function isRenderObservation(value: unknown, outputKind: "app-html" | "app-rsc"): boolean {
  if (!isUnknownRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "boundaryOutcome",
      "cacheTags",
      "cacheability",
      "completeness",
      "downgrade",
      "dynamicFetches",
      "output",
      "pathTags",
      "requestApis",
      "schemaVersion",
    ]) &&
    value.schemaVersion === CACHE_PROOF_MODEL_SCHEMA_VERSION &&
    isOutputScope(value.output, outputKind) &&
    RENDER_OBSERVATION_COMPLETENESS.has(value.completeness) &&
    isBoundaryOutcome(value.boundaryOutcome) &&
    Array.isArray(value.requestApis) &&
    value.requestApis.every(
      (requestApi: unknown) =>
        isUnknownRecord(requestApi) &&
        hasExactKeys(requestApi, ["kind", "status"]) &&
        RENDER_REQUEST_API_KINDS.has(requestApi.kind) &&
        RENDER_REQUEST_API_STATUSES.has(requestApi.status),
    ) &&
    isStringArray(value.dynamicFetches) &&
    isStringArray(value.cacheTags) &&
    isStringArray(value.pathTags) &&
    RENDER_CACHEABILITY.has(value.cacheability) &&
    isDowngrade(value.downgrade)
  );
}

function isOutputScope(value: unknown, kind: "app-html" | "app-rsc"): boolean {
  if (!isUnknownRecord(value) || value.kind !== kind) return false;
  const common =
    isStringOrNull(value.renderEpoch) &&
    isStringOrNull(value.rootBoundaryId) &&
    typeof value.routeId === "string";
  return kind === "app-html"
    ? common && hasExactKeys(value, ["kind", "renderEpoch", "rootBoundaryId", "routeId"])
    : common &&
        isStringOrNull(value.mountedSlotsFingerprint) &&
        hasExactKeys(value, [
          "kind",
          "mountedSlotsFingerprint",
          "renderEpoch",
          "rootBoundaryId",
          "routeId",
        ]);
}

function isBoundaryOutcome(value: unknown): boolean {
  if (!isUnknownRecord(value) || !BOUNDARY_OUTCOME_KINDS.has(value.kind)) return false;
  switch (value.kind) {
    case "error":
    case "globalError":
      return Object.hasOwn(value, "digest")
        ? typeof value.digest === "string" && hasExactKeys(value, ["kind", "digest"])
        : hasExactKeys(value, ["kind"]);
    case "redirect":
      return (
        typeof value.location === "string" &&
        typeof value.status === "number" &&
        hasExactKeys(value, ["kind", "location", "status"])
      );
    default:
      return hasExactKeys(value, ["kind"]);
  }
}

function isDowngrade(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  return (
    hasExactKeys(value, ["fallback", "isPublicCacheCandidate", "reasons", "target"]) &&
    (value.fallback === null || isBreakerFallback(value.fallback)) &&
    typeof value.isPublicCacheCandidate === "boolean" &&
    Array.isArray(value.reasons) &&
    value.reasons.every(isDowngradeReason) &&
    DOWNGRADE_TARGETS.has(value.target)
  );
}

function isBreakerFallback(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    hasExactKeys(value, ["code", "fields", "kind", "mode", "scope"]) &&
    value.kind === "breakerFallback" &&
    isCacheProofRejectionCode(value.code) &&
    isCacheProofFallbackMode(value.mode) &&
    isCacheProofFallbackScope(value.scope) &&
    isUnknownRecord(value.fields) &&
    Object.values(value.fields).every(
      (field) =>
        field === null ||
        typeof field === "string" ||
        typeof field === "number" ||
        typeof field === "boolean" ||
        isStringArray(field),
    )
  );
}

type DowngradeReasonCode = CacheProofDowngradeReason["code"];

/**
 * The values each field of a downgrade reason may take, besides its `code`:
 * a number, or one of the listed values. Typed against
 * `CacheProofDowngradeReason`, so every reason and each of its fields must be
 * listed, with only values that reason allows.
 */
type DowngradeReason<Code extends DowngradeReasonCode> = Extract<
  CacheProofDowngradeReason,
  { code: Code }
>;

type DowngradeReasonFieldSpec<Code extends DowngradeReasonCode> = {
  readonly [
    Field in Exclude<keyof DowngradeReason<Code>, "code">
  ]-?: DowngradeReason<Code>[Field] extends number
    ? "number"
    : readonly DowngradeReason<Code>[Field][];
};

const DOWNGRADE_REASON_FIELDS: {
  readonly [Code in DowngradeReasonCode]: DowngradeReasonFieldSpec<Code>;
} = {
  CP_DOWNGRADE_CACHEABILITY_PRIVATE: { target: ["private"] },
  CP_DOWNGRADE_CACHEABILITY_UNCACHEABLE: { target: ["privateUncacheable"] },
  CP_DOWNGRADE_CACHEABILITY_UNKNOWN: { target: ["freshRender"] },
  CP_DOWNGRADE_DYNAMIC_FETCH: { dynamicFetchCount: "number", target: ["freshRender"] },
  CP_DOWNGRADE_DYNAMIC_REQUEST_API: { requestApi: ["connection"], target: ["freshRender"] },
  CP_DOWNGRADE_DRAFT_MODE: { requestApi: ["draftMode"], target: ["privateUncacheable"] },
  CP_DOWNGRADE_INCOMPLETE_OBSERVATION: {
    completeness: ["partial", "unknown"],
    target: ["freshRender"],
  },
  CP_DOWNGRADE_PRIVATE_DIMENSION: {
    inputClass: ["auth", "draft", "private", "session"],
    source: ["auth", "cookie", "draft-mode", "header", "session"],
    target: ["private", "privateUncacheable"],
  },
  CP_DOWNGRADE_PRIVATE_REQUEST_API: { requestApi: ["cookies", "headers"], target: ["private"] },
  CP_DOWNGRADE_PUBLIC_REQUEST_API: {
    requestApi: ["params", "searchParams"],
    target: ["publicVariant"],
  },
  CP_DOWNGRADE_UNKNOWN_REQUEST_API: {
    requestApi: ALL_RENDER_REQUEST_API_KINDS,
    target: ["freshRender"],
  },
};

function isDowngradeReason(value: unknown): boolean {
  if (
    !isUnknownRecord(value) ||
    typeof value.code !== "string" ||
    !Object.hasOwn(DOWNGRADE_REASON_FIELDS, value.code)
  ) {
    return false;
  }
  const fields: Readonly<Record<string, "number" | readonly unknown[]>> =
    DOWNGRADE_REASON_FIELDS[value.code as DowngradeReasonCode];
  return (
    hasExactKeys(value, ["code", ...Object.keys(fields)]) &&
    Object.entries(fields).every(([field, allowed]) =>
      allowed === "number" ? typeof value[field] === "number" : allowed.includes(value[field]),
    )
  );
}
