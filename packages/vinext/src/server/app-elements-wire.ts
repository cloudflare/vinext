import { isValidElement, type ReactNode } from "react";
import {
  createArtifactCompatibilityEnvelope,
  parseArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";

const APP_INTERCEPTION_SEPARATOR = "\0";

export const APP_ARTIFACT_COMPATIBILITY_KEY = "__artifactCompatibility";
export const APP_INTERCEPTION_CONTEXT_KEY = "__interceptionContext";
export const APP_LAYOUT_IDS_KEY = "__layoutIds";
export const APP_LAYOUT_FLAGS_KEY = "__layoutFlags";
export const APP_ROUTE_KEY = "__route";
export const APP_ROOT_LAYOUT_KEY = "__rootLayout";
export const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");

export type AppElementValue = ReactNode | typeof UNMATCHED_SLOT | string | null;
type AppWireElementValue = ReactNode | string | null;

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
  interceptionContext: string | null;
  layoutIds: readonly string[];
  layoutFlags: LayoutFlags;
  routeId: string;
  rootLayoutTreePath: string | null;
};

type AppElementsWireElementKey =
  | { kind: "layout"; treePath: string }
  | { interceptionContext: string | null; kind: "page"; path: string }
  | { interceptionContext: string | null; kind: "route"; path: string }
  | { kind: "slot"; name: string; treePath: string }
  | { kind: "template"; treePath: string };

type AppElementsWireMetadataInput = {
  interceptionContext: string | null;
  layoutIds?: readonly string[];
  routeId: string;
  rootLayoutTreePath: string | null;
};

type AppElementsWireMetadataEntries = Readonly<{
  [APP_ROUTE_KEY]: string;
  [APP_INTERCEPTION_CONTEXT_KEY]: string | null;
  [APP_LAYOUT_IDS_KEY]: readonly string[];
  [APP_ROOT_LAYOUT_KEY]: string | null;
}>;

/**
 * The outgoing wire payload shape. Includes ReactNode values for the
 * rendered tree plus metadata values like LayoutFlags attached under
 * known keys (e.g. __layoutFlags). Distinct from AppElements / AppWireElements
 * which only carry render-time values.
 */
export type AppOutgoingElements = Readonly<
  Record<string, ReactNode | LayoutFlags | ArtifactCompatibilityEnvelope>
>;

type AppElementsWireKeys = {
  readonly artifactCompatibility: typeof APP_ARTIFACT_COMPATIBILITY_KEY;
  readonly interceptionContext: typeof APP_INTERCEPTION_CONTEXT_KEY;
  readonly layoutIds: typeof APP_LAYOUT_IDS_KEY;
  readonly layoutFlags: typeof APP_LAYOUT_FLAGS_KEY;
  readonly rootLayout: typeof APP_ROOT_LAYOUT_KEY;
  readonly route: typeof APP_ROUTE_KEY;
};

type AppElementsWireCodec = {
  readonly keys: AppElementsWireKeys;
  readonly unmatchedSlotValue: typeof APP_UNMATCHED_SLOT_WIRE_VALUE;
  createMetadataEntries(input: AppElementsWireMetadataInput): AppElementsWireMetadataEntries;
  decode(elements: AppWireElements): AppElements;
  encodeCacheKey(rscUrl: string, interceptionContext: string | null): string;
  encodeLayoutId(treePath: string): string;
  encodeOutgoingPayload(input: {
    element: ReactNode | Readonly<Record<string, ReactNode>>;
    artifactCompatibility?: ArtifactCompatibilityEnvelope;
    layoutFlags: LayoutFlags;
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
  return {
    [APP_ROUTE_KEY]: input.routeId,
    [APP_INTERCEPTION_CONTEXT_KEY]: input.interceptionContext,
    [APP_LAYOUT_IDS_KEY]: [...(input.layoutIds ?? [])],
    [APP_ROOT_LAYOUT_KEY]: input.rootLayoutTreePath,
  };
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

function parseLayoutIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      "[vinext] Invalid __layoutIds in App Router payload: expected layout id string[]",
    );
  }

  const layoutIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        "[vinext] Invalid __layoutIds in App Router payload: expected layout id string[]",
      );
    }

    const parsed = parseAppElementsWireElementKey(entry);
    if (parsed?.kind !== "layout") {
      throw new Error("[vinext] Invalid __layoutIds in App Router payload: expected layout ids");
    }

    layoutIds.push(entry);
  }
  return layoutIds;
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
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  artifactCompatibility?: ArtifactCompatibilityEnvelope;
  layoutFlags: LayoutFlags;
}): ReactNode | AppOutgoingElements {
  if (!isAppElementsRecord(input.element)) {
    return input.element;
  }
  return {
    ...input.element,
    [APP_LAYOUT_FLAGS_KEY]: input.layoutFlags,
    [APP_ARTIFACT_COMPATIBILITY_KEY]:
      input.artifactCompatibility ?? createArtifactCompatibilityEnvelope(),
  };
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
  const artifactCompatibility = readArtifactCompatibilityMetadata(
    elements[APP_ARTIFACT_COMPATIBILITY_KEY],
  );

  return {
    artifactCompatibility,
    interceptionContext: interceptionContext ?? null,
    layoutIds,
    layoutFlags,
    routeId,
    rootLayoutTreePath,
  };
}

export const AppElementsWire: AppElementsWireCodec = {
  // WIRE follow-ups use these stable key names when moving payload readers and writers
  // behind the codec boundary.
  keys: {
    artifactCompatibility: APP_ARTIFACT_COMPATIBILITY_KEY,
    interceptionContext: APP_INTERCEPTION_CONTEXT_KEY,
    layoutIds: APP_LAYOUT_IDS_KEY,
    layoutFlags: APP_LAYOUT_FLAGS_KEY,
    rootLayout: APP_ROOT_LAYOUT_KEY,
    route: APP_ROUTE_KEY,
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
