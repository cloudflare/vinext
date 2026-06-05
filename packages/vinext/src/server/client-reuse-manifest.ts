import {
  parseArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";
import { AppElementsWire } from "./app-elements-wire.js";
import { fnv1a64 } from "../utils/hash.js";
import { isUnknownRecord } from "../utils/record.js";

export const CLIENT_REUSE_MANIFEST_SCHEMA_VERSION = 1;
export type ClientReuseManifestSchemaVersion = 1;

export const CLIENT_REUSE_MANIFEST_HASH_ALGORITHM = "fnv1a64";
export type ClientReuseManifestHashAlgorithm = typeof CLIENT_REUSE_MANIFEST_HASH_ALGORITHM;

type ClientReuseManifestLimits = Readonly<{
  maxEntryCount: number;
  maxEntryIdLength: number;
  maxManifestBytes: number;
  maxPayloadHashLength: number;
  maxVariantCacheKeyLength: number;
}>;

export const DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS = {
  maxEntryCount: 64,
  maxEntryIdLength: 512,
  maxManifestBytes: 4096,
  maxPayloadHashLength: 16,
  maxVariantCacheKeyLength: 256,
} satisfies ClientReuseManifestLimits;

// Producer cap for normal browser manifests. The parser accepts a larger
// hostile-input envelope, but browser-produced manifests should stay within
// the server skip planner's verification budget.
export const CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET = 8;

export type ClientReuseManifestEntryKind = "layout" | "page" | "route" | "slot" | "template";
type ClientReuseManifestEntryPrivacy = "private" | "public";

export type ClientReuseManifestReplayWindow = Readonly<{
  validFromVisibleCommitVersion: number;
  validUntilVisibleCommitVersion: number;
}>;

export type ClientReuseManifestEntry = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  id: string;
  kind: ClientReuseManifestEntryKind;
  payloadHash: string;
  privacy: "public";
  variantCacheKey: string;
}>;

type ClientReuseManifestWireEntry = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  id: string;
  payloadHash: string;
  privacy: ClientReuseManifestEntryPrivacy;
  variantCacheKey: string;
}>;

export type ClientReuseManifest = Readonly<{
  entries: readonly ClientReuseManifestEntry[];
  hashAlgorithm: ClientReuseManifestHashAlgorithm;
  replayWindow: ClientReuseManifestReplayWindow;
  schemaVersion: ClientReuseManifestSchemaVersion;
  visibleCommitVersion: number;
}>;

// Internal: createClientReuseManifest returns wire shape while parsing decides
// which client-declared entries can participate in future reuse.
type ClientReuseManifestWire = Readonly<{
  entries: readonly ClientReuseManifestWireEntry[];
  hashAlgorithm: ClientReuseManifestHashAlgorithm;
  replayWindow: ClientReuseManifestReplayWindow;
  schemaVersion: ClientReuseManifestSchemaVersion;
  visibleCommitVersion: number;
}>;

type CreateClientReuseManifestInput = Readonly<{
  entries: readonly ClientReuseManifestWireEntry[];
  replayWindow?: ClientReuseManifestReplayWindow;
  visibleCommitVersion: number;
}>;

export type ClientReuseManifestRejectionCode =
  | "SKIP_CACHE_ARTIFACT_COMPATIBILITY_INCOMPATIBLE"
  | "SKIP_CACHE_ARTIFACT_COMPATIBILITY_UNKNOWN"
  | "SKIP_CACHE_ARTIFACT_PROOF_MISMATCH"
  | "SKIP_CACHE_ENTRY_ID_MISMATCH"
  | "SKIP_CACHE_INVALIDATED"
  | "SKIP_CACHE_INVALIDATION_UNKNOWN"
  | "SKIP_CACHE_PAYLOAD_HASH_MISMATCH"
  | "SKIP_CACHE_PAYLOAD_HASH_MISSING"
  | "SKIP_CACHE_PROOF_MISSING"
  | "SKIP_CACHE_PROOF_REJECTED"
  | "SKIP_CACHE_REUSE_CLASS_UNSUPPORTED"
  | "SKIP_CACHE_VARIANT_MISMATCH"
  | "SKIP_LAYOUT_CACHE_LIFE_OBSERVED"
  | "SKIP_LAYOUT_CACHE_TAGS_OBSERVED"
  | "SKIP_LAYOUT_CACHEABLE_FETCHES_OBSERVED"
  | "SKIP_LAYOUT_DYNAMIC_FETCHES_OBSERVED"
  | "SKIP_LAYOUT_DYNAMIC_USAGE_OBSERVED"
  | "SKIP_LAYOUT_PARAMS_OBSERVED"
  | "SKIP_LAYOUT_PARAMS_OBSERVATION_INCOMPLETE"
  | "SKIP_LAYOUT_PARAMS_PRESENT"
  | "SKIP_LAYOUT_REVALIDATE_PRESENT"
  | "SKIP_LAYOUT_REQUEST_API_OBSERVED"
  | "SKIP_LAYOUT_UNSTABLE_CACHE_OBSERVED"
  | "SKIP_ARTIFACT_COMPATIBILITY_INVALID"
  | "SKIP_ENTRY_COUNT_EXCEEDED"
  | "SKIP_VERIFICATION_BUDGET_EXCEEDED"
  | "SKIP_ENTRY_HASH_INVALID"
  | "SKIP_ENTRY_ID_INVALID"
  | "SKIP_ENTRY_ID_TOO_LONG"
  | "SKIP_ENTRY_MALFORMED"
  | "SKIP_ENTRY_ORDER_NON_CANONICAL"
  | "SKIP_HASH_ALGORITHM_UNSUPPORTED"
  | "SKIP_MANIFEST_MALFORMED"
  | "SKIP_MANIFEST_SCHEMA_UNSUPPORTED"
  | "SKIP_MANIFEST_TOO_LARGE"
  | "SKIP_PRIVATE_ENTRY"
  | "SKIP_REPLAY_WINDOW_INVALID"
  | "SKIP_UNKNOWN_ENTRY"
  | "SKIP_VARIANT_CACHE_KEY_INVALID"
  | "SKIP_VARIANT_CACHE_KEY_TOO_LONG"
  | "SKIP_VISIBLE_COMMIT_VERSION_INVALID"
  | "SKIP_VISIBLE_COMMIT_VERSION_MISMATCH";

export type ClientReuseManifestTraceFieldValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export type ClientReuseManifestTraceFields = Readonly<
  Record<string, ClientReuseManifestTraceFieldValue>
>;

export type ClientReuseManifestRejection = Readonly<{
  code: ClientReuseManifestRejectionCode;
  fields: ClientReuseManifestTraceFields;
}>;

export type ClientReuseManifestEntryRejection = ClientReuseManifestRejection &
  Readonly<{
    entryId: string | null;
  }>;

export type ClientReuseManifestSkipDisposition =
  | Readonly<{
      code: "SKIP_MODEL_DISABLED";
      enabled: false;
      mode: "renderAndSend";
    }>
  | Readonly<{
      code: "SKIP_STATIC_LAYOUT_VERIFIED";
      enabled: true;
      mode: "skipStaticLayout";
      skippedEntryIds: readonly string[];
    }>;

export type ClientReuseManifestParseResult =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "rejected"; rejection: ClientReuseManifestRejection }>
  | Readonly<{
      entryRejections: readonly ClientReuseManifestEntryRejection[];
      kind: "parsed";
      manifest: ClientReuseManifest;
      skipDisposition: ClientReuseManifestSkipDisposition;
    }>;

type ParseClientReuseManifestOptions = Readonly<{
  currentVisibleCommitVersion?: number;
  limits?: ClientReuseManifestLimits;
}>;

const HASH_DIGEST_PATTERN = /^[0-9a-z]+$/;
const textEncoder = new TextEncoder();

type ParseReplayWindowResult =
  | Readonly<{ kind: "parsed"; replayWindow: ClientReuseManifestReplayWindow }>
  | Readonly<{ kind: "rejected"; rejection: ClientReuseManifestRejection }>;

function createRejection(
  code: ClientReuseManifestRejectionCode,
  fields: ClientReuseManifestTraceFields = {},
): ClientReuseManifestRejection {
  return { code, fields };
}

function rejectManifest(
  code: ClientReuseManifestRejectionCode,
  fields: ClientReuseManifestTraceFields = {},
): ClientReuseManifestParseResult {
  return { kind: "rejected", rejection: createRejection(code, fields) };
}

function rejectEntry(
  code: ClientReuseManifestRejectionCode,
  entryId: string | null,
  fields: ClientReuseManifestTraceFields = {},
): ClientReuseManifestEntryRejection {
  return { code, entryId, fields };
}

function compareManifestEntries(
  left: Pick<ClientReuseManifestWireEntry, "id">,
  right: Pick<ClientReuseManifestWireEntry, "id">,
): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function createCanonicalWireEntries(
  entries: readonly ClientReuseManifestWireEntry[],
): ClientReuseManifestWireEntry[] {
  const entriesById = new Map<string, ClientReuseManifestWireEntry>();
  for (const entry of entries) {
    if (!entriesById.has(entry.id)) {
      entriesById.set(entry.id, entry);
    }
  }

  return Array.from(entriesById.values()).sort(compareManifestEntries);
}

// Manifest byte budgets are enforced over UTF-8 encoded header values.
export function countUtf8Bytes(input: string): number {
  return textEncoder.encode(input).length;
}

function isVisibleCommitVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseReplayWindow(value: unknown, visibleCommitVersion: number): ParseReplayWindowResult {
  if (!isUnknownRecord(value)) {
    return {
      kind: "rejected",
      rejection: createRejection("SKIP_REPLAY_WINDOW_INVALID", { field: "replayWindow" }),
    };
  }

  const validFromVisibleCommitVersion = value.validFromVisibleCommitVersion;
  const validUntilVisibleCommitVersion = value.validUntilVisibleCommitVersion;
  if (
    !isVisibleCommitVersion(validFromVisibleCommitVersion) ||
    !isVisibleCommitVersion(validUntilVisibleCommitVersion) ||
    validFromVisibleCommitVersion > validUntilVisibleCommitVersion ||
    visibleCommitVersion < validFromVisibleCommitVersion ||
    visibleCommitVersion > validUntilVisibleCommitVersion
  ) {
    return {
      kind: "rejected",
      rejection: createRejection("SKIP_REPLAY_WINDOW_INVALID", {
        validFromVisibleCommitVersion: isVisibleCommitVersion(validFromVisibleCommitVersion)
          ? validFromVisibleCommitVersion
          : null,
        validUntilVisibleCommitVersion: isVisibleCommitVersion(validUntilVisibleCommitVersion)
          ? validUntilVisibleCommitVersion
          : null,
        visibleCommitVersion,
      }),
    };
  }

  return {
    kind: "parsed",
    replayWindow: {
      validFromVisibleCommitVersion,
      validUntilVisibleCommitVersion,
    },
  };
}

function currentCommitVersionMatchesReplayWindow(
  currentVisibleCommitVersion: number | undefined,
  replayWindow: ClientReuseManifestReplayWindow,
): boolean {
  if (currentVisibleCommitVersion === undefined) return true;
  return (
    currentVisibleCommitVersion >= replayWindow.validFromVisibleCommitVersion &&
    currentVisibleCommitVersion <= replayWindow.validUntilVisibleCommitVersion
  );
}

function parseEntryKind(id: string): ClientReuseManifestEntryKind | null {
  const parsed = AppElementsWire.parseElementKey(id);
  if (parsed === null) return null;
  return parsed.kind;
}

function isValidPayloadHash(value: unknown, limits: ClientReuseManifestLimits): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limits.maxPayloadHashLength &&
    HASH_DIGEST_PATTERN.test(value)
  );
}

function parseManifestEntry(
  value: unknown,
  limits: ClientReuseManifestLimits,
  index: number,
): ClientReuseManifestEntry | ClientReuseManifestEntryRejection {
  if (!isUnknownRecord(value)) {
    return rejectEntry("SKIP_ENTRY_MALFORMED", null, { index });
  }

  const id = value.id;
  if (typeof id !== "string" || id.length === 0) {
    return rejectEntry("SKIP_ENTRY_ID_INVALID", null, { index });
  }
  if (id.length > limits.maxEntryIdLength) {
    return rejectEntry("SKIP_ENTRY_ID_TOO_LONG", id, {
      idHash: createClientReusePayloadHash(id),
      maxEntryIdLength: limits.maxEntryIdLength,
    });
  }

  const kind = parseEntryKind(id);
  if (kind === null) {
    return rejectEntry("SKIP_UNKNOWN_ENTRY", id, { idHash: createClientReusePayloadHash(id) });
  }

  const privacy = value.privacy;
  if (privacy === "private") {
    return rejectEntry("SKIP_PRIVATE_ENTRY", id, { privacy });
  }
  if (privacy !== "public") {
    return rejectEntry("SKIP_ENTRY_MALFORMED", id, { field: "privacy" });
  }

  const payloadHash = value.payloadHash;
  if (!isValidPayloadHash(payloadHash, limits)) {
    return rejectEntry("SKIP_ENTRY_HASH_INVALID", id, {
      maxPayloadHashLength: limits.maxPayloadHashLength,
    });
  }

  const variantCacheKey = value.variantCacheKey;
  if (typeof variantCacheKey !== "string" || variantCacheKey.length === 0) {
    return rejectEntry("SKIP_VARIANT_CACHE_KEY_INVALID", id, { field: "variantCacheKey" });
  }
  if (variantCacheKey.length > limits.maxVariantCacheKeyLength) {
    return rejectEntry("SKIP_VARIANT_CACHE_KEY_TOO_LONG", id, {
      maxVariantCacheKeyLength: limits.maxVariantCacheKeyLength,
      variantCacheKeyHash: createClientReusePayloadHash(variantCacheKey),
    });
  }

  const artifactCompatibility = parseArtifactCompatibilityEnvelope(value.artifactCompatibility);
  if (artifactCompatibility === null) {
    return rejectEntry("SKIP_ARTIFACT_COMPATIBILITY_INVALID", id, {
      field: "artifactCompatibility",
    });
  }

  return {
    artifactCompatibility,
    id,
    kind,
    payloadHash,
    privacy,
    variantCacheKey,
  };
}

export function createClientReusePayloadHash(input: string): string {
  return fnv1a64(input);
}

export function createClientReuseManifest(
  input: CreateClientReuseManifestInput,
): ClientReuseManifestWire {
  const replayWindow =
    input.replayWindow ??
    ({
      validFromVisibleCommitVersion: input.visibleCommitVersion,
      validUntilVisibleCommitVersion: input.visibleCommitVersion,
    } satisfies ClientReuseManifestReplayWindow);

  return {
    entries: createCanonicalWireEntries(input.entries),
    hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
    replayWindow,
    schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
    visibleCommitVersion: input.visibleCommitVersion,
  };
}

export function serializeClientReuseManifest(input: CreateClientReuseManifestInput): string {
  return JSON.stringify(createClientReuseManifest(input));
}

export function parseClientReuseManifestHeader(
  rawHeader: string | null | undefined,
  options: ParseClientReuseManifestOptions = {},
): ClientReuseManifestParseResult {
  const header = rawHeader?.trim();
  if (!header) return { kind: "absent" };

  const limits = options.limits ?? DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS;
  const manifestBytes = countUtf8Bytes(header);
  if (manifestBytes > limits.maxManifestBytes) {
    return rejectManifest("SKIP_MANIFEST_TOO_LARGE", {
      manifestBytes,
      maxManifestBytes: limits.maxManifestBytes,
    });
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(header);
  } catch {
    return rejectManifest("SKIP_MANIFEST_MALFORMED");
  }

  if (!isUnknownRecord(decoded)) {
    return rejectManifest("SKIP_MANIFEST_MALFORMED", { field: "manifest" });
  }

  if (decoded.schemaVersion !== CLIENT_REUSE_MANIFEST_SCHEMA_VERSION) {
    return rejectManifest("SKIP_MANIFEST_SCHEMA_UNSUPPORTED", {
      schemaVersion:
        typeof decoded.schemaVersion === "number" || typeof decoded.schemaVersion === "string"
          ? decoded.schemaVersion
          : null,
    });
  }

  if (decoded.hashAlgorithm !== CLIENT_REUSE_MANIFEST_HASH_ALGORITHM) {
    return rejectManifest("SKIP_HASH_ALGORITHM_UNSUPPORTED", {
      hashAlgorithm: typeof decoded.hashAlgorithm === "string" ? decoded.hashAlgorithm : null,
    });
  }

  const visibleCommitVersion = decoded.visibleCommitVersion;
  if (!isVisibleCommitVersion(visibleCommitVersion)) {
    return rejectManifest("SKIP_VISIBLE_COMMIT_VERSION_INVALID", {
      visibleCommitVersion: null,
    });
  }

  const replayWindowResult = parseReplayWindow(decoded.replayWindow, visibleCommitVersion);
  if (replayWindowResult.kind === "rejected") {
    return { kind: "rejected", rejection: replayWindowResult.rejection };
  }
  const { replayWindow } = replayWindowResult;
  if (!currentCommitVersionMatchesReplayWindow(options.currentVisibleCommitVersion, replayWindow)) {
    return rejectManifest("SKIP_VISIBLE_COMMIT_VERSION_MISMATCH", {
      currentVisibleCommitVersion: options.currentVisibleCommitVersion ?? null,
      validFromVisibleCommitVersion: replayWindow.validFromVisibleCommitVersion,
      validUntilVisibleCommitVersion: replayWindow.validUntilVisibleCommitVersion,
      visibleCommitVersion,
    });
  }

  const entriesValue = decoded.entries;
  if (!Array.isArray(entriesValue)) {
    return rejectManifest("SKIP_MANIFEST_MALFORMED", { field: "entries" });
  }
  if (entriesValue.length > limits.maxEntryCount) {
    return rejectManifest("SKIP_ENTRY_COUNT_EXCEEDED", {
      entryCount: entriesValue.length,
      maxEntryCount: limits.maxEntryCount,
    });
  }

  const entries: ClientReuseManifestEntry[] = [];
  const entryRejections: ClientReuseManifestEntryRejection[] = [];
  let previousEntryId: string | null = null;

  for (let index = 0; index < entriesValue.length; index++) {
    const value = entriesValue[index];
    if (isUnknownRecord(value) && typeof value.id === "string") {
      // Canonical ordering is enforced over entries with string IDs. Malformed
      // entries cannot advance previousEntryId, so interleaving them cannot hide
      // an ordering violation between valid checkpoints. <= rejects both
      // out-of-order and duplicate IDs.
      if (previousEntryId !== null && value.id <= previousEntryId) {
        return rejectManifest("SKIP_ENTRY_ORDER_NON_CANONICAL", {
          entryIdHash: createClientReusePayloadHash(value.id),
          previousEntryIdHash: createClientReusePayloadHash(previousEntryId),
        });
      }
      previousEntryId = value.id;
    }

    const parsedEntry = parseManifestEntry(value, limits, index);
    if ("code" in parsedEntry) {
      entryRejections.push(parsedEntry);
    } else {
      entries.push(parsedEntry);
    }
  }

  return {
    entryRejections,
    kind: "parsed",
    manifest: {
      entries,
      hashAlgorithm: CLIENT_REUSE_MANIFEST_HASH_ALGORITHM,
      replayWindow,
      schemaVersion: CLIENT_REUSE_MANIFEST_SCHEMA_VERSION,
      visibleCommitVersion,
    },
    skipDisposition: {
      code: "SKIP_MODEL_DISABLED",
      enabled: false,
      mode: "renderAndSend",
    },
  };
}
