import { isValidElement, type ReactNode } from "react";
import {
  createArtifactCompatibilityEnvelope,
  parseArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";
import type {
  CacheEntryReuseProof,
  CacheProofBreakerFallbackMode,
  CacheProofFallbackScope,
  CacheProofRejectionCode,
  RenderObservation,
} from "./cache-proof.js";
import type { ClientReuseManifestSkipDisposition } from "./client-reuse-manifest.js";
import { isInterceptionMatchedUrlPath } from "./normalize-path.js";
import { releaseAppElementRenderDependency } from "./app-render-dependency.js";
import { compareStrings } from "../utils/compare.js";
import { isUnknownRecord } from "../utils/record.js";

const APP_INTERCEPTION_SEPARATOR = "\0";

export const APP_ARTIFACT_COMPATIBILITY_KEY = "__artifactCompatibility";
export const APP_CACHE_ENTRY_REUSE_PROOF_KEY = "__cacheEntryReuseProof";
export const APP_DYNAMIC_STALE_TIME_KEY = "__dynamicStaleTime";
export const APP_INTERCEPTION_KEY = "__interception";
export const APP_INTERCEPTION_CONTEXT_KEY = "__interceptionContext";
export const APP_LAYOUT_IDS_KEY = "__layoutIds";
export const APP_LAYOUT_FLAGS_KEY = "__layoutFlags";
export const APP_RENDER_OBSERVATION_KEY = "__renderObservation";
export const APP_ROUTE_KEY = "__route";
export const APP_ROOT_LAYOUT_KEY = "__rootLayout";
export const APP_SKIPPED_LAYOUT_IDS_KEY = "__skippedLayoutIds";
export const APP_SOURCE_PAGE_KEY = "__sourcePage";
export const APP_SLOT_BINDINGS_KEY = "__slotBindings";
/**
 * Static sibling segment names for the matched route, surfaced so the client
 * router can determine if a cached prefetch of a dynamic route can be reused
 * when navigating to a static sibling URL.
 *
 * Mirrors Next.js's `staticSiblings` tuple element on the loader-tree dynamic
 * segments (issue cloudflare/vinext#1525).
 */
export const APP_STATIC_SIBLINGS_KEY = "__staticSiblings";
export const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");
const EMPTY_SKIPPED_LAYOUT_IDS: ReadonlySet<string> = new Set();

function createCacheProofRejectionCodeSet<const T extends readonly CacheProofRejectionCode[]>(
  codes: T &
    ([CacheProofRejectionCode] extends [T[number]]
      ? unknown
      : readonly [
          "Missing cache proof rejection codes",
          Exclude<CacheProofRejectionCode, T[number]>,
        ]),
): ReadonlySet<string> {
  return new Set(codes);
}

const CACHE_PROOF_REJECTION_CODES = createCacheProofRejectionCodeSet([
  "CP_CACHE_ENTRY_PROOF_MISSING",
  "CP_MODEL_DISABLED",
  "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
  "CP_ARTIFACT_COMPATIBILITY_UNKNOWN",
  "CP_DIMENSION_COUNT_EXCEEDED",
  "CP_DIMENSION_NAME_MISSING",
  "CP_DIMENSION_NAME_TOO_LONG",
  "CP_DIMENSION_VALUE_COUNT_EXCEEDED",
  "CP_DIMENSION_VALUE_TOO_LONG",
  "CP_DIMENSION_VALUES_MISSING",
  "CP_ENCODED_VARIANT_TOO_LONG",
  "CP_INVALID_VARIANT_BUDGET",
  "CP_ROUTE_VARIANT_BUDGET_ROUTE_MISMATCH",
  "CP_ROUTE_VARIANT_CEILING_EXCEEDED",
  "CP_UNSAFE_PUBLIC_DIMENSION",
  "CP_BOUNDARY_OUTCOME_MISMATCH",
  "CP_BOUNDARY_OUTCOME_UNKNOWN",
  "CP_PRIVATE_DYNAMIC_DOWNGRADE",
  "CP_STATIC_LAYOUT_CANDIDATE_OUTPUT_KIND",
  "CP_STATIC_LAYOUT_CURRENT_OUTPUT_KIND",
  "CP_STATIC_LAYOUT_ID_MISMATCH",
  "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_KIND",
  "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_MISMATCH",
  "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE",
  "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED",
  "CP_STATIC_LAYOUT_REQUEST_API_UNKNOWN",
  "CP_STATIC_LAYOUT_ROOT_BOUNDARY_MISMATCH",
  "CP_STATIC_LAYOUT_ROOT_BOUNDARY_UNKNOWN",
  "CP_STATIC_LAYOUT_VARIANT_DIMENSION_UNPROVEN",
]);

type AppElementsSlotBindingState = "active" | "default" | "unmatched";

export type AppElementsSlotBinding = Readonly<{
  activeRouteId?: string | null;
  ownerLayoutId: string | null;
  slotId: string;
  state: AppElementsSlotBindingState;
}>;

export type AppElementsInterception = Readonly<{
  sourceMatchedUrl: string;
  sourceRouteId: string;
  slotId: string;
  targetMatchedUrl: string;
  targetRouteId: string;
}>;

export const compareAppElementsSlotIds = compareStrings;

function compareAppElementsSlotBindingsBySlotId(
  left: Pick<AppElementsSlotBinding, "slotId">,
  right: Pick<AppElementsSlotBinding, "slotId">,
): number {
  return compareAppElementsSlotIds(left.slotId, right.slotId);
}

export function normalizeAppElementsSlotBindings(
  slotBindings: readonly AppElementsSlotBinding[],
  options: { layoutIds?: readonly string[] } = {},
): readonly AppElementsSlotBinding[] {
  const ownerLayoutIds = options.layoutIds ? new Set(options.layoutIds) : null;
  const seenSlotIds = new Set<string>();
  const normalized: AppElementsSlotBinding[] = [];

  for (const binding of slotBindings) {
    if (seenSlotIds.has(binding.slotId)) {
      throw new Error("[vinext] Invalid __slotBindings in App Router payload: duplicate slot id");
    }
    seenSlotIds.add(binding.slotId);

    if (
      ownerLayoutIds &&
      binding.ownerLayoutId !== null &&
      !ownerLayoutIds.has(binding.ownerLayoutId)
    ) {
      throw new Error(
        "[vinext] Invalid __slotBindings in App Router payload: owner layout id missing from __layoutIds",
      );
    }

    normalized.push({ ...binding });
  }

  return normalized.sort(compareAppElementsSlotBindingsBySlotId);
}

export type AppElementValue =
  | ReactNode
  | typeof UNMATCHED_SLOT
  | string
  | null
  | LayoutFlags
  | ArtifactCompatibilityEnvelope
  | CacheEntryReuseProof
  | AppElementsInterception
  | readonly string[]
  | readonly AppElementsSlotBinding[];
type AppWireElementValue =
  | ReactNode
  | string
  | null
  | LayoutFlags
  | ArtifactCompatibilityEnvelope
  | CacheEntryReuseProof
  | AppElementsInterception
  | readonly string[]
  | readonly AppElementsSlotBinding[];

export type AppElements = Readonly<Record<string, AppElementValue>>;
export type AppWireElements = Readonly<Record<string, AppWireElementValue>>;

/**
 * Per-layout static/dynamic flags. `"s"` = static (skippable on next nav);
 * `"d"` = dynamic (must always render).
 *
 * Lifecycle (partial — later PRs extend this):
 *
 *   1. PROBE   — probeAppPageLayouts (server/app-page-execution.ts) returns
 *                LayoutFlags for every layout in the route at render time.
 *
 *   2. ATTACH  — AppElementsWire.encodeOutgoingPayload writes `__layoutFlags`
 *                into the outgoing App Router payload record.
 *
 *   3. WIRE    — renderToReadableStream serializes the record as RSC row 0.
 *
 *   4. PARSE   — AppElementsWire.readMetadata extracts layoutFlags from the
 *                wire payload on the client side.
 */
export type LayoutFlags = Readonly<Record<string, "s" | "d">>;

type AppElementsMetadata = {
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  cacheEntryReuseProof?: CacheEntryReuseProof;
  dynamicStaleTimeSeconds?: number;
  interception: AppElementsInterception | null;
  interceptionContext: string | null;
  layoutIds: readonly string[];
  layoutFlags: LayoutFlags;
  routeId: string;
  rootLayoutTreePath: string | null;
  skippedLayoutIds: readonly string[];
  slotBindings: readonly AppElementsSlotBinding[];
  sourcePage: string | null;
};

type AppElementsWireElementKey =
  | { kind: "layout"; treePath: string }
  | { interceptionContext: string | null; kind: "page"; path: string }
  | { interceptionContext: string | null; kind: "route"; path: string }
  | { kind: "slot"; name: string; treePath: string }
  | { kind: "template"; treePath: string };

type AppElementsWireMetadataInput = {
  dynamicStaleTimeSeconds?: number;
  interception?: AppElementsInterception | null;
  interceptionContext: string | null;
  layoutIds?: readonly string[];
  routeId: string;
  rootLayoutTreePath: string | null;
  slotBindings?: readonly AppElementsSlotBinding[];
  sourcePage?: string | null;
};

type AppElementsWireMetadataEntries = Readonly<{
  [APP_DYNAMIC_STALE_TIME_KEY]?: number;
  [APP_ROUTE_KEY]: string;
  [APP_INTERCEPTION_KEY]?: AppElementsInterception;
  [APP_INTERCEPTION_CONTEXT_KEY]: string | null;
  [APP_LAYOUT_IDS_KEY]: readonly string[];
  [APP_ROOT_LAYOUT_KEY]: string | null;
  [APP_SOURCE_PAGE_KEY]?: string;
  [APP_SLOT_BINDINGS_KEY]?: readonly AppElementsSlotBinding[];
}>;

/**
 * The outgoing wire payload shape. Includes ReactNode values for the
 * rendered tree plus metadata values like LayoutFlags attached under
 * known keys (e.g. __layoutFlags). Distinct from AppElements / AppWireElements
 * which only carry render-time values.
 */
export type AppOutgoingElements = Readonly<
  Record<
    string,
    | ReactNode
    | LayoutFlags
    | ArtifactCompatibilityEnvelope
    | CacheEntryReuseProof
    | AppElementsInterception
    | RenderObservation
    | number
    | readonly string[]
    | readonly AppElementsSlotBinding[]
  >
>;

type AppElementsWireKeys = {
  readonly artifactCompatibility: typeof APP_ARTIFACT_COMPATIBILITY_KEY;
  readonly cacheEntryReuseProof: typeof APP_CACHE_ENTRY_REUSE_PROOF_KEY;
  readonly dynamicStaleTime: typeof APP_DYNAMIC_STALE_TIME_KEY;
  readonly interception: typeof APP_INTERCEPTION_KEY;
  readonly interceptionContext: typeof APP_INTERCEPTION_CONTEXT_KEY;
  readonly layoutIds: typeof APP_LAYOUT_IDS_KEY;
  readonly layoutFlags: typeof APP_LAYOUT_FLAGS_KEY;
  readonly renderObservation: typeof APP_RENDER_OBSERVATION_KEY;
  readonly rootLayout: typeof APP_ROOT_LAYOUT_KEY;
  readonly route: typeof APP_ROUTE_KEY;
  readonly skippedLayoutIds: typeof APP_SKIPPED_LAYOUT_IDS_KEY;
  readonly slotBindings: typeof APP_SLOT_BINDINGS_KEY;
  readonly sourcePage: typeof APP_SOURCE_PAGE_KEY;
};

type AppElementsWireCodec = {
  readonly keys: AppElementsWireKeys;
  readonly unmatchedSlotValue: typeof APP_UNMATCHED_SLOT_WIRE_VALUE;
  createMetadataEntries(input: AppElementsWireMetadataInput): AppElementsWireMetadataEntries;
  decode(elements: AppWireElements): AppElements;
  encodeCacheKey(rscUrl: string, interceptionContext: string | null): string;
  encodeLayoutId(treePath: string): string;
  encodeOutgoingPayload(input: {
    element: ReactNode | AppElements;
    artifactCompatibility?: ArtifactCompatibilityEnvelope;
    cacheEntryReuseProof?: CacheEntryReuseProof;
    dynamicStaleTimeSeconds?: number;
    layoutFlags: LayoutFlags;
    renderObservation?: RenderObservation;
    skipDisposition?: ClientReuseManifestSkipDisposition;
  }): ReactNode | AppOutgoingElements;
  encodePageId(routePath: string, interceptionContext: string | null): string;
  encodeRouteId(routePath: string, interceptionContext: string | null): string;
  encodeSlotId(slotName: string, treePath: string): string;
  encodeTemplateId(treePath: string): string;
  isSlotId(key: string): boolean;
  parseElementKey(key: string): AppElementsWireElementKey | null;
  readMetadata(elements: Readonly<Record<string, unknown>>): AppElementsMetadata;
  withLayoutFlags<T extends Record<string, unknown>>(
    elements: T,
    layoutFlags: LayoutFlags,
  ): T & { [APP_LAYOUT_FLAGS_KEY]: LayoutFlags };
};

function appendInterceptionContext(identity: string, interceptionContext: string | null): string {
  return interceptionContext === null
    ? identity
    : `${identity}${APP_INTERCEPTION_SEPARATOR}${interceptionContext}`;
}

function createAppPayloadRouteId(routePath: string, interceptionContext: string | null): string {
  return appendInterceptionContext(`route:${routePath}`, interceptionContext);
}

function createAppPayloadPageId(routePath: string, interceptionContext: string | null): string {
  return appendInterceptionContext(`page:${routePath}`, interceptionContext);
}

function createAppPayloadLayoutId(treePath: string): string {
  return `layout:${treePath}`;
}

function createAppPayloadTemplateId(treePath: string): string {
  return `template:${treePath}`;
}

function createAppPayloadSlotId(slotName: string, treePath: string): string {
  return `slot:${slotName}:${treePath}`;
}

function createAppPayloadCacheKey(rscUrl: string, interceptionContext: string | null): string {
  return appendInterceptionContext(rscUrl, interceptionContext);
}

function parsePathWithInterception(input: string): {
  interceptionContext: string | null;
  path: string;
} | null {
  const separatorIndex = input.indexOf(APP_INTERCEPTION_SEPARATOR);
  const path = separatorIndex === -1 ? input : input.slice(0, separatorIndex);
  if (!path.startsWith("/")) return null;

  return {
    interceptionContext: separatorIndex === -1 ? null : input.slice(separatorIndex + 1),
    path,
  };
}

/**
 * AppElements tree paths are absolute route-tree paths on the wire.
 * Bare segment names are not valid layout/template/slot tree identities.
 */
function parseTreePath(input: string): string | null {
  return input.startsWith("/") ? input : null;
}

function parseAppElementsWireElementKey(key: string): AppElementsWireElementKey | null {
  if (key.startsWith("route:")) {
    const parsed = parsePathWithInterception(key.slice("route:".length));
    if (!parsed) return null;
    return { interceptionContext: parsed.interceptionContext, kind: "route", path: parsed.path };
  }

  if (key.startsWith("page:")) {
    const parsed = parsePathWithInterception(key.slice("page:".length));
    if (!parsed) return null;
    return { interceptionContext: parsed.interceptionContext, kind: "page", path: parsed.path };
  }

  if (key.startsWith("layout:")) {
    const treePath = parseTreePath(key.slice("layout:".length));
    return treePath ? { kind: "layout", treePath } : null;
  }

  if (key.startsWith("template:")) {
    const treePath = parseTreePath(key.slice("template:".length));
    return treePath ? { kind: "template", treePath } : null;
  }

  if (key.startsWith("slot:")) {
    const body = key.slice("slot:".length);
    const separatorIndex = body.indexOf(":");
    if (separatorIndex <= 0) return null;
    const name = body.slice(0, separatorIndex);
    const treePath = parseTreePath(body.slice(separatorIndex + 1));
    return treePath ? { kind: "slot", name, treePath } : null;
  }

  return null;
}

function isAppElementsWireSlotId(key: string): boolean {
  if (!key.startsWith("slot:")) return false;
  const body = key.slice("slot:".length);
  const separatorIndex = body.indexOf(":");
  return separatorIndex > 0 && body.charCodeAt(separatorIndex + 1) === 0x2f;
}

function createAppElementsWireMetadataEntries(
  input: AppElementsWireMetadataInput,
): AppElementsWireMetadataEntries {
  const layoutIds = [...(input.layoutIds ?? [])];
  const entries: AppElementsWireMetadataEntries = {
    [APP_ROUTE_KEY]: input.routeId,
    [APP_INTERCEPTION_CONTEXT_KEY]: input.interceptionContext,
    [APP_LAYOUT_IDS_KEY]: layoutIds,
    [APP_ROOT_LAYOUT_KEY]: input.rootLayoutTreePath,
    ...(input.dynamicStaleTimeSeconds === undefined
      ? {}
      : { [APP_DYNAMIC_STALE_TIME_KEY]: input.dynamicStaleTimeSeconds }),
    ...(input.sourcePage === null || input.sourcePage === undefined
      ? {}
      : { [APP_SOURCE_PAGE_KEY]: input.sourcePage }),
  };
  // Empty slot binding metadata is intentionally omitted. Missing
  // __slotBindings round-trips as [] and means "no route-state proof", so
  // default/unmatched slot preservation is not promoted for that payload.
  const entriesWithInterception = input.interception
    ? { ...entries, [APP_INTERCEPTION_KEY]: input.interception }
    : entries;
  if (input.slotBindings && input.slotBindings.length > 0) {
    return {
      ...entriesWithInterception,
      [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(input.slotBindings, { layoutIds }),
    };
  }
  return entriesWithInterception;
}

export function normalizeAppElements(elements: AppWireElements): AppElements {
  let needsNormalization = false;
  for (const [key, value] of Object.entries(elements)) {
    if (isAppElementsWireSlotId(key) && value === APP_UNMATCHED_SLOT_WIRE_VALUE) {
      needsNormalization = true;
      break;
    }
  }

  if (!needsNormalization) {
    return elements;
  }

  const normalized: Record<string, AppElementValue> = {};
  for (const [key, value] of Object.entries(elements)) {
    normalized[key] =
      isAppElementsWireSlotId(key) && value === APP_UNMATCHED_SLOT_WIRE_VALUE
        ? UNMATCHED_SLOT
        : value;
  }

  return normalized;
}

function isLayoutFlagsRecord(value: unknown): value is LayoutFlags {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (v !== "s" && v !== "d") return false;
  }
  return true;
}

function parseLayoutFlags(value: unknown): LayoutFlags {
  if (isLayoutFlagsRecord(value)) return value;
  return {};
}

function parseLayoutIdList(value: unknown, fieldName: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `[vinext] Invalid ${fieldName} in App Router payload: expected layout id string[]`,
    );
  }

  const layoutIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `[vinext] Invalid ${fieldName} in App Router payload: expected layout id string[]`,
      );
    }

    const parsed = parseAppElementsWireElementKey(entry);
    if (parsed?.kind !== "layout") {
      throw new Error(`[vinext] Invalid ${fieldName} in App Router payload: expected layout ids`);
    }

    layoutIds.push(entry);
  }
  return layoutIds;
}

function parseLayoutIds(value: unknown): readonly string[] {
  return parseLayoutIdList(value, APP_LAYOUT_IDS_KEY);
}

function parseSkippedLayoutIds(value: unknown): readonly string[] {
  return parseLayoutIdList(value, APP_SKIPPED_LAYOUT_IDS_KEY);
}

function isSlotBindingState(value: unknown): value is AppElementsSlotBindingState {
  return value === "active" || value === "default" || value === "unmatched";
}

function parseSlotBindings(
  value: unknown,
  options: { layoutIds?: readonly string[] } = {},
): readonly AppElementsSlotBinding[] {
  // Missing metadata is compatibility-safe but not semantic proof: callers see
  // an empty binding list, so promoted default/unmatched slot preservation is
  // denied instead of inferred from legacy transport shape.
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("[vinext] Invalid __slotBindings in App Router payload: expected array");
  }

  const slotBindings: AppElementsSlotBinding[] = [];
  for (const entry of value) {
    if (!isUnknownRecord(entry)) {
      throw new Error("[vinext] Invalid __slotBindings in App Router payload: expected objects");
    }

    const slotId = entry.slotId;
    if (typeof slotId !== "string" || parseAppElementsWireElementKey(slotId)?.kind !== "slot") {
      throw new Error("[vinext] Invalid __slotBindings in App Router payload: expected slot ids");
    }

    const ownerLayoutId = entry.ownerLayoutId;
    if (
      ownerLayoutId !== null &&
      (typeof ownerLayoutId !== "string" ||
        parseAppElementsWireElementKey(ownerLayoutId)?.kind !== "layout")
    ) {
      throw new Error(
        "[vinext] Invalid __slotBindings in App Router payload: expected owner layout ids",
      );
    }

    const state = entry.state;
    if (!isSlotBindingState(state)) {
      throw new Error("[vinext] Invalid __slotBindings in App Router payload: expected state");
    }

    const activeRouteId = entry.activeRouteId;
    if (
      activeRouteId !== undefined &&
      activeRouteId !== null &&
      (typeof activeRouteId !== "string" ||
        parseAppElementsWireElementKey(activeRouteId)?.kind !== "route")
    ) {
      throw new Error("[vinext] Invalid __slotBindings in App Router payload: expected route ids");
    }

    slotBindings.push({
      ...(activeRouteId !== undefined ? { activeRouteId } : {}),
      ownerLayoutId,
      slotId,
      state,
    });
  }
  return normalizeAppElementsSlotBindings(slotBindings, options);
}

function readRequiredInterceptionString(
  entry: Record<string, unknown>,
  fieldName: keyof AppElementsInterception,
): string {
  const value = entry[fieldName];
  if (typeof value !== "string") {
    throw new Error("[vinext] Invalid __interception in App Router payload: expected strings");
  }
  return value;
}

function parseInterceptionMatchedUrl(value: string): string {
  if (!isInterceptionMatchedUrlPath(value)) {
    throw new Error("[vinext] Invalid __interception in App Router payload: expected path URLs");
  }
  return value;
}

function parseInterceptionRouteId(value: string, matchedUrl: string): string {
  const parsed = parseAppElementsWireElementKey(value);
  if (
    parsed?.kind !== "route" ||
    parsed.path !== matchedUrl ||
    parsed.interceptionContext !== null
  ) {
    throw new Error("[vinext] Invalid __interception in App Router payload: expected route ids");
  }
  return value;
}

function parseInterceptionSlotId(value: string): string {
  if (parseAppElementsWireElementKey(value)?.kind !== "slot") {
    throw new Error("[vinext] Invalid __interception in App Router payload: expected slot id");
  }
  return value;
}

function parseInterceptionMetadata(value: unknown): AppElementsInterception | null {
  if (value === undefined || value === null) return null;
  if (!isUnknownRecord(value)) {
    throw new Error("[vinext] Invalid __interception in App Router payload: expected object");
  }

  const sourceMatchedUrl = parseInterceptionMatchedUrl(
    readRequiredInterceptionString(value, "sourceMatchedUrl"),
  );
  const targetMatchedUrl = parseInterceptionMatchedUrl(
    readRequiredInterceptionString(value, "targetMatchedUrl"),
  );
  return {
    sourceMatchedUrl,
    sourceRouteId: parseInterceptionRouteId(
      readRequiredInterceptionString(value, "sourceRouteId"),
      sourceMatchedUrl,
    ),
    slotId: parseInterceptionSlotId(readRequiredInterceptionString(value, "slotId")),
    targetMatchedUrl,
    targetRouteId: parseInterceptionRouteId(
      readRequiredInterceptionString(value, "targetRouteId"),
      targetMatchedUrl,
    ),
  };
}

/**
 * Type predicate for a plain (non-null, non-array) record of app payload values.
 * Used to distinguish the App Router payload object from bare React elements at
 * the render boundary. Narrows to `Readonly<Record<string, unknown>>` because
 * the outgoing payload carries heterogeneous values (ReactNodes for the rendered
 * tree, plus metadata like `__layoutFlags` which is a plain object). Delegates
 * to React's canonical `isValidElement` so we don't depend on React's internal
 * `$$typeof` marker scheme.
 */
export function isAppElementsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (isValidElement(value)) return false;
  return true;
}

export function withLayoutFlags<T extends Record<string, unknown>>(
  elements: T,
  layoutFlags: LayoutFlags,
): T & { [APP_LAYOUT_FLAGS_KEY]: LayoutFlags } {
  return { ...elements, [APP_LAYOUT_FLAGS_KEY]: layoutFlags };
}

export function buildOutgoingAppPayload(input: {
  element: ReactNode | AppElements;
  artifactCompatibility?: ArtifactCompatibilityEnvelope;
  cacheEntryReuseProof?: CacheEntryReuseProof;
  dynamicStaleTimeSeconds?: number;
  layoutFlags: LayoutFlags;
  renderObservation?: RenderObservation;
  skipDisposition?: ClientReuseManifestSkipDisposition;
}): ReactNode | AppOutgoingElements {
  if (!isAppElementsRecord(input.element)) {
    return input.element;
  }
  const skippedLayoutIds = createSkippedLayoutIds(input.skipDisposition);
  const payload: Record<
    string,
    | ReactNode
    | LayoutFlags
    | ArtifactCompatibilityEnvelope
    | CacheEntryReuseProof
    | AppElementsInterception
    | RenderObservation
    | number
    | readonly string[]
    | readonly AppElementsSlotBinding[]
  > = {};
  for (const [key, value] of Object.entries(input.element)) {
    if (skippedLayoutIds.has(key)) {
      releaseAppElementRenderDependency(input.element, key);
      continue;
    }
    payload[key] = value === UNMATCHED_SLOT ? APP_UNMATCHED_SLOT_WIRE_VALUE : value;
  }
  payload[APP_LAYOUT_FLAGS_KEY] = input.layoutFlags;
  if (skippedLayoutIds.size > 0) {
    payload[APP_SKIPPED_LAYOUT_IDS_KEY] = [...skippedLayoutIds];
  }
  payload[APP_ARTIFACT_COMPATIBILITY_KEY] =
    input.artifactCompatibility ?? createArtifactCompatibilityEnvelope();
  if (input.cacheEntryReuseProof) {
    payload[APP_CACHE_ENTRY_REUSE_PROOF_KEY] = input.cacheEntryReuseProof;
  }
  if (input.dynamicStaleTimeSeconds !== undefined) {
    payload[APP_DYNAMIC_STALE_TIME_KEY] = input.dynamicStaleTimeSeconds;
  }
  if (input.renderObservation) {
    payload[APP_RENDER_OBSERVATION_KEY] = input.renderObservation;
  }
  return payload;
}

function createSkippedLayoutIds(
  skipDisposition: ClientReuseManifestSkipDisposition | undefined,
): ReadonlySet<string> {
  if (skipDisposition?.enabled !== true) return EMPTY_SKIPPED_LAYOUT_IDS;

  const skippedLayoutIds = new Set<string>();
  for (const id of skipDisposition.skippedEntryIds) {
    if (parseAppElementsWireElementKey(id)?.kind === "layout") {
      skippedLayoutIds.add(id);
    }
  }
  return skippedLayoutIds;
}

function readArtifactCompatibilityMetadata(value: unknown): ArtifactCompatibilityEnvelope {
  if (value === undefined) return createArtifactCompatibilityEnvelope();

  const artifactCompatibility = parseArtifactCompatibilityEnvelope(value);
  // TODO(#726-COMPAT-04): hard-fail malformed compatibility metadata once
  // cache/skip consumers depend on this proof. During Wave01 the field is
  // emitted as scaffolding, so bad or future-version values degrade like
  // missing __layoutFlags instead of crashing render paths that do not read it.
  return artifactCompatibility ?? createArtifactCompatibilityEnvelope();
}

function readSourcePageMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  return value;
}

function createMissingCacheEntryReuseProof(): CacheEntryReuseProof {
  return {
    kind: "runtime-cache-entry",
    decision: null,
  };
}

function isCacheProofRejectionCode(value: unknown): value is CacheProofRejectionCode {
  return typeof value === "string" && CACHE_PROOF_REJECTION_CODES.has(value);
}

function isCacheProofFallbackMode(value: unknown): value is CacheProofBreakerFallbackMode {
  return value === "renderFresh" || value === "privateUncacheable";
}

function isCacheProofFallbackScope(value: unknown): value is CacheProofFallbackScope {
  return value === "affectedOutput" || value === "route";
}

// Three-way wire semantics are intentional:
// - null means the proof field was absent and no cache authority was claimed.
// - { decision: null } means a present proof was malformed or unusable.
// - { decision: ... } means the proof parsed into an explicit reuse decision.
function parseCacheEntryReuseProofMetadata(value: unknown): CacheEntryReuseProof | null {
  if (value === undefined) return null;
  if (!isUnknownRecord(value) || value.kind !== "runtime-cache-entry") {
    return createMissingCacheEntryReuseProof();
  }

  const decision = value.decision;
  if (decision === null) return createMissingCacheEntryReuseProof();
  if (!isUnknownRecord(decision)) return createMissingCacheEntryReuseProof();

  if (
    decision.kind === "reuse" &&
    decision.canReuse === true &&
    decision.code === "CP_STATIC_LAYOUT_REUSE_PROVEN" &&
    // Static layout proofs are the only runtime cache-entry reuse class today.
    // Extend this parser alongside any new reuse class before it can restore
    // visited cache entries as commit-capable payloads.
    decision.reuseClass === "static-layout"
  ) {
    return {
      kind: "runtime-cache-entry",
      decision: {
        canReuse: true,
        code: decision.code,
        kind: "reuse",
        reuseClass: decision.reuseClass,
      },
    };
  }

  if (
    decision.kind === "reject" &&
    decision.canReuse === false &&
    isCacheProofRejectionCode(decision.code) &&
    isCacheProofFallbackMode(decision.mode) &&
    isCacheProofFallbackScope(decision.scope)
  ) {
    return {
      kind: "runtime-cache-entry",
      decision: {
        canReuse: false,
        code: decision.code,
        kind: "reject",
        mode: decision.mode,
        scope: decision.scope,
      },
    };
  }

  return createMissingCacheEntryReuseProof();
}

export function readAppElementsMetadata(
  elements: Readonly<Record<string, unknown>>,
): AppElementsMetadata {
  const routeId = elements[APP_ROUTE_KEY];
  if (typeof routeId !== "string") {
    throw new Error("[vinext] Missing __route string in App Router payload");
  }

  const interceptionContext = elements[APP_INTERCEPTION_CONTEXT_KEY];
  if (
    interceptionContext !== undefined &&
    interceptionContext !== null &&
    typeof interceptionContext !== "string"
  ) {
    throw new Error("[vinext] Invalid __interceptionContext in App Router payload");
  }

  const rootLayoutTreePath = elements[APP_ROOT_LAYOUT_KEY];
  if (rootLayoutTreePath === undefined) {
    throw new Error("[vinext] Missing __rootLayout key in App Router payload");
  }
  if (rootLayoutTreePath !== null && typeof rootLayoutTreePath !== "string") {
    throw new Error("[vinext] Invalid __rootLayout in App Router payload: expected string or null");
  }

  const layoutFlags = parseLayoutFlags(elements[APP_LAYOUT_FLAGS_KEY]);
  const layoutIds = parseLayoutIds(elements[APP_LAYOUT_IDS_KEY]);
  const skippedLayoutIds = parseSkippedLayoutIds(elements[APP_SKIPPED_LAYOUT_IDS_KEY]);
  const slotBindings = parseSlotBindings(elements[APP_SLOT_BINDINGS_KEY], { layoutIds });
  const interception = parseInterceptionMetadata(elements[APP_INTERCEPTION_KEY]);
  const artifactCompatibility = readArtifactCompatibilityMetadata(
    elements[APP_ARTIFACT_COMPATIBILITY_KEY],
  );
  const cacheEntryReuseProof = parseCacheEntryReuseProofMetadata(
    elements[APP_CACHE_ENTRY_REUSE_PROOF_KEY],
  );
  const dynamicStaleTime = elements[APP_DYNAMIC_STALE_TIME_KEY];
  const dynamicStaleTimeSeconds =
    typeof dynamicStaleTime === "number" &&
    Number.isFinite(dynamicStaleTime) &&
    dynamicStaleTime >= 0
      ? dynamicStaleTime
      : undefined;
  const sourcePage = readSourcePageMetadata(elements[APP_SOURCE_PAGE_KEY]);

  return {
    artifactCompatibility,
    ...(cacheEntryReuseProof ? { cacheEntryReuseProof } : {}),
    ...(dynamicStaleTimeSeconds === undefined ? {} : { dynamicStaleTimeSeconds }),
    interception,
    interceptionContext: interceptionContext ?? null,
    layoutIds,
    layoutFlags,
    routeId,
    rootLayoutTreePath,
    skippedLayoutIds,
    slotBindings,
    sourcePage,
  };
}

export const AppElementsWire: AppElementsWireCodec = {
  // WIRE follow-ups use these stable key names when moving payload readers and writers
  // behind the codec boundary.
  keys: {
    artifactCompatibility: APP_ARTIFACT_COMPATIBILITY_KEY,
    cacheEntryReuseProof: APP_CACHE_ENTRY_REUSE_PROOF_KEY,
    dynamicStaleTime: APP_DYNAMIC_STALE_TIME_KEY,
    interception: APP_INTERCEPTION_KEY,
    interceptionContext: APP_INTERCEPTION_CONTEXT_KEY,
    layoutIds: APP_LAYOUT_IDS_KEY,
    layoutFlags: APP_LAYOUT_FLAGS_KEY,
    renderObservation: APP_RENDER_OBSERVATION_KEY,
    rootLayout: APP_ROOT_LAYOUT_KEY,
    route: APP_ROUTE_KEY,
    skippedLayoutIds: APP_SKIPPED_LAYOUT_IDS_KEY,
    slotBindings: APP_SLOT_BINDINGS_KEY,
    sourcePage: APP_SOURCE_PAGE_KEY,
  },
  unmatchedSlotValue: APP_UNMATCHED_SLOT_WIRE_VALUE,
  createMetadataEntries: createAppElementsWireMetadataEntries,
  decode: normalizeAppElements,
  encodeCacheKey: createAppPayloadCacheKey,
  encodeLayoutId: createAppPayloadLayoutId,
  encodeOutgoingPayload: buildOutgoingAppPayload,
  encodePageId: createAppPayloadPageId,
  encodeRouteId: createAppPayloadRouteId,
  encodeSlotId: createAppPayloadSlotId,
  encodeTemplateId: createAppPayloadTemplateId,
  isSlotId: isAppElementsWireSlotId,
  parseElementKey: parseAppElementsWireElementKey,
  readMetadata: readAppElementsMetadata,
  withLayoutFlags,
};
