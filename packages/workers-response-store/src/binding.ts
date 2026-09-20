import { WorkerEntrypoint } from "cloudflare:workers";

import { deriveCachePolicy, edgeCacheControl, representationAge } from "./cache-policy";
import { IsolateNegativeCache } from "./isolate-negative-cache";
import type { CacheMetadataStub } from "./metadata-do";

type RevalidatorDescriptor = {
  id: string;
  args: SerializableValue[];
};

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export type ResponseStorePutOptions = {
  /** @internal Collapse overlapping framework writes for the same cache key. */
  coalesce?: boolean;
  revalidator?: RevalidatorDescriptor;
  purgeExisting?: boolean;
};

export type ResponseStoreRefreshOptions = {
  tags?: string[];
  pathPrefixes?: string[];
};

export type ResponseStorePurgeOptions = ResponseStoreRefreshOptions & {
  purgeEverything?: boolean;
};

export type ResponseStoreMutationResult = {
  backingStoreUpdated: boolean;
  edgePurgeAccepted: boolean;
};

export type RevalidationReason = "swr" | "expired" | "missing" | "manual";

export type RevalidationInput = {
  request: Request;
  id: string;
  args: SerializableValue[];
  reason: RevalidationReason;
};

export type WorkersResponseStore = {
  fetch(request: Request): Promise<Response>;
  /** @internal Return the latest purge timestamp for framework-managed cache tags. */
  getTagExpiration(tags: string[]): Promise<number>;
  put(
    request: Request,
    response: Response,
    options?: ResponseStorePutOptions,
  ): Promise<ResponseStoreMutationResult>;
  refresh(options: ResponseStoreRefreshOptions): Promise<ResponseStoreMutationResult>;
  purge(options: ResponseStorePurgeOptions): Promise<ResponseStoreMutationResult>;
};

type EntryMetadata = {
  objectKey: string;
  statusText: string;
  responseHeaders: [string, string][];
  freshUntil: number;
  swrUntil: number;
  revalidator: RevalidatorDescriptor | null;
  cacheTags: string[];
};

export type CandidateMetadata = EntryMetadata & {
  fenceTags: string[];
};

export type StoredEntry = EntryMetadata & {
  keyHash: string;
  cacheKey: string;
  activeRevision: number;
  latestRevision: number;
};

export type PurgedEntry = {
  keyHash: string;
  cacheKey: string;
  objectKey: string;
  revision: number;
};

export type RevalidationService = {
  regenerate(input: RevalidationInput): Promise<Response>;
};

type CacheKey = {
  cacheKey: string;
  keyHash: string;
};

type WriteReservation = CacheKey & {
  claimId?: string;
  fenceTags: string[];
  objectKey: string;
  r2ObjectAbsent?: boolean;
  revision: number;
};

type StoreResult = {
  published: boolean;
  entry: StoredEntry | null;
  response?: Response;
};

type PublicationResult = {
  entry: StoredEntry | null;
  published: boolean;
};

export type WorkersResponseStoreEnv = {
  CACHE_BODIES: R2Bucket;
  CACHE_METADATA: DurableObjectNamespace<undefined>;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
};

export type WorkersResponseStoreProps = {
  versionId?: string;
  locationHint?: DurableObjectLocationHint;
  revalidator?: RevalidationService;
  shards?: number;
};

export type ResponseStoreServiceProps = Pick<WorkersResponseStoreProps, "locationHint">;

export type ResponseStoreServiceInvocation = {
  versionId: string;
  revalidator: RevalidationService;
  shards?: number;
};

type ResponseStoreBindingFactory = WorkersResponseStore &
  ((options: { props: WorkersResponseStoreProps }) => WorkersResponseStore);

export type ResponseStoreExecutionContext = Pick<ExecutionContext, "exports">;

export function getWorkersResponseStore(
  ctx: ResponseStoreExecutionContext,
  props: WorkersResponseStoreProps = {},
): WorkersResponseStore {
  const binding = Reflect.get(ctx.exports, "ResponseStoreBinding") as
    | ResponseStoreBindingFactory
    | undefined;
  if (typeof binding !== "function") {
    throw new Error("The ResponseStoreBinding entrypoint is not exported");
  }
  return binding({ props });
}

export class ResponseStoreService extends WorkerEntrypoint<
  WorkersResponseStoreEnv,
  ResponseStoreServiceProps
> {
  private getStore(invocation: ResponseStoreServiceInvocation): WorkersResponseStore {
    return getWorkersResponseStore(this.ctx, {
      ...this.ctx.props,
      ...invocation,
    });
  }

  read(request: Request, invocation: ResponseStoreServiceInvocation): Promise<Response> {
    return this.getStore(invocation).fetch(request);
  }

  getTagExpiration(tags: string[], invocation: ResponseStoreServiceInvocation): Promise<number> {
    return this.getStore(invocation).getTagExpiration(tags);
  }

  put(
    request: Request,
    response: Response,
    options: ResponseStorePutOptions,
    invocation: ResponseStoreServiceInvocation,
  ): Promise<ResponseStoreMutationResult> {
    return this.getStore(invocation).put(request, response, options);
  }

  refresh(
    options: ResponseStoreRefreshOptions,
    invocation: ResponseStoreServiceInvocation,
  ): Promise<ResponseStoreMutationResult> {
    return this.getStore(invocation).refresh(options);
  }

  purge(
    options: ResponseStorePurgeOptions,
    invocation: ResponseStoreServiceInvocation,
  ): Promise<ResponseStoreMutationResult> {
    return this.getStore(invocation).purge(options);
  }
}

export type ResponseStoreServiceBinding = Pick<
  ResponseStoreService,
  "read" | "getTagExpiration" | "put" | "refresh" | "purge"
>;

const MISS_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Workers-Response-Store": "MISS",
};

const BACKGROUND_REVALIDATION_LEASE_MS = 30_000;
const CACHE_PURGE_BATCH_SIZE = 100;
const PURGE_TOMBSTONE_BATCH_SIZE = 400;
const ISOLATE_MISS_CACHE_CAPACITY = 1_024;
const ISOLATE_MISS_CACHE_TTL_MS = 1_000;
const MAX_R2_CAS_ATTEMPTS = 3;
const MAX_CACHE_TAG_HEADER_BYTES = 16 * 1024;
const R2_CUSTOM_METADATA_SAFE_BYTES = 7 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const AGE_BASIS_HEADER = "X-Workers-Response-Store-Age-Basis";
const STORAGE_LAYOUT_VERSION = "r2-v1";
const pendingPuts = new Map<string, Promise<StoreResult>>();
const pendingR2Reads = new Map<string, Promise<boolean>>();
const entryReads = new IsolateNegativeCache<string>(
  ISOLATE_MISS_CACHE_CAPACITY,
  ISOLATE_MISS_CACHE_TTL_MS,
);

export function validateResponseStoreShards(shards: number | undefined): number | undefined {
  if (shards !== undefined && (!Number.isSafeInteger(shards) || shards <= 1)) {
    throw new TypeError("Workers Response Store shards must be an integer greater than 1");
  }
  return shards;
}

function* batches<T>(values: readonly T[], size: number): Generator<T[], void> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size);
  }
}

function metadataInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function metadataJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isHeaderEntries(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((item) => typeof item === "string"),
    )
  );
}

function customMetadataSize(metadata: Record<string, string>): number {
  const encoder = new TextEncoder();
  return Object.entries(metadata).reduce(
    (size, [key, value]) =>
      size + encoder.encode(key).byteLength + encoder.encode(value).byteLength,
    0,
  );
}

async function readBodyPrefix(
  body: ReadableStream<Uint8Array>,
  prefixLength: number,
): Promise<{ prefix: Uint8Array; remainder: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < prefixLength) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("R2 response metadata prefix is incomplete");
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  const buffered = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const leftover = buffered.subarray(prefixLength);
  return {
    prefix: buffered.subarray(0, prefixLength),
    remainder: new ReadableStream<Uint8Array>({
      start(controller) {
        if (leftover.byteLength) controller.enqueue(leftover);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

function purgeTagForEntry(entry: Pick<StoredEntry, "keyHash">): string {
  return `runtime-cache-${entry.keyHash}`;
}

function cacheTagHeader(entry: Pick<StoredEntry, "keyHash" | "cacheTags">): string {
  const requiredTag = purgeTagForEntry(entry);
  const tags = [requiredTag];
  const seen = new Set([requiredTag.toLowerCase()]);
  let headerLength = requiredTag.length;

  for (const tag of entry.cacheTags) {
    const normalized = tag.toLowerCase();
    if (!/^[!-~]+$/.test(tag) || tag.includes(",") || seen.has(normalized)) {
      continue;
    }

    const addedLength = tag.length + 1;
    if (headerLength + addedLength > MAX_CACHE_TAG_HEADER_BYTES) {
      continue;
    }

    tags.push(tag);
    seen.add(normalized);
    headerLength += addedLength;
  }

  return tags.join(",");
}

function cacheTagsFromResponse(response: Response): string[] {
  return [
    ...new Set(
      (response.headers.get("Cache-Tag") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export class ResponseStoreBinding extends WorkerEntrypoint<
  WorkersResponseStoreEnv,
  WorkersResponseStoreProps
> {
  private readonly shardCount = validateResponseStoreShards(this.ctx.props?.shards) ?? 1;

  private getVersionId(): string {
    const versionId = this.ctx.props?.versionId ?? this.env.CF_VERSION_METADATA?.id;
    if (!versionId) {
      throw new Error("Workers Response Store requires a version_metadata binding");
    }

    return versionId;
  }

  private getMetadataShard(index: number): CacheMetadataStub {
    const locationHint = this.ctx.props?.locationHint;
    const shards = this.shardCount;
    const versionId = this.getVersionId();
    const layoutName = `${versionId}:${STORAGE_LAYOUT_VERSION}`;
    const name = shards === 1 ? layoutName : `${layoutName}:metadata-shard:${index}-of-${shards}`;

    return this.env.CACHE_METADATA.getByName(
      name,
      locationHint ? { locationHint } : undefined,
    ) as CacheMetadataStub;
  }

  private getMetadata(keyHash: string): CacheMetadataStub {
    const shards = this.shardCount;
    const index = shards === 1 ? 0 : Number.parseInt(keyHash.slice(0, 8), 16) % shards;
    return this.getMetadataShard(index);
  }

  private getMetadataShards(): CacheMetadataStub[] {
    return Array.from({ length: this.shardCount }, (_, index) => this.getMetadataShard(index));
  }

  private entryReadKey(keyHash: string): string {
    return `${this.getVersionId()}:${this.shardCount}:${keyHash}`;
  }

  private invalidateEntryRead(keyHash: string): void {
    const key = this.entryReadKey(keyHash);
    entryReads.delete(key);
    pendingR2Reads.delete(key);
  }

  private getTagMetadata(tags: string[]): CacheMetadataStub {
    const shards = this.shardCount;
    if (shards === 1) return this.getMetadataShard(0);

    // Invalidations are replicated to every shard. Pick a stable replica per
    // tag set so soft-tag reads do not all converge on shard 0.
    let hash = 0x811c9dc5;
    const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
      .sort()
      .join("\0");
    for (let index = 0; index < normalized.length; index++) {
      hash = Math.imul(hash ^ normalized.charCodeAt(index), 0x01000193);
    }
    return this.getMetadataShard((hash >>> 0) % shards);
  }

  private async deriveCacheKey(request: Request): Promise<CacheKey> {
    if (request.method !== "GET") {
      throw new TypeError("Workers Response Store keys must be GET requests");
    }

    const url = new URL(request.url);
    const cacheKey = `${url.pathname}${url.search}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cacheKey));
    const keyHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return { cacheKey, keyHash };
  }

  private async purgeEdgeCache(options: CachePurgeOptions): Promise<boolean> {
    if (!this.ctx.cache) {
      console.error(
        JSON.stringify({
          message: "Workers Response Store cache purge is unavailable",
          reason: "ctx.cache is absent",
        }),
      );
      return false;
    }

    try {
      const result = await this.ctx.cache.purge(options);
      if (!result.success) {
        throw new Error(
          result.errors.map(({ code, message }) => `${code}: ${message}`).join(", ") ||
            "Workers Response Store cache purge was rejected",
        );
      }
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Workers Response Store cache purge failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  private async purgeEdgeCacheByTags(tags: string[]): Promise<boolean> {
    let accepted = true;

    for (const batch of batches(tags, CACHE_PURGE_BATCH_SIZE)) {
      if (!(await this.purgeEdgeCache({ tags: batch }))) {
        accepted = false;
      }
    }

    return accepted;
  }

  private async purgePendingEdgeEntries(
    metadata: CacheMetadataStub,
    purgeByTag: boolean,
  ): Promise<boolean> {
    let accepted = true;
    for (;;) {
      const entries = await metadata.listPendingEdgePurges(PURGE_TOMBSTONE_BATCH_SIZE);
      if (!entries.length) return accepted;
      if (purgeByTag && !(await this.purgeEdgeCacheByTags(entries.map(purgeTagForEntry)))) {
        accepted = false;
      }
      await metadata.markTombstonesEdgePurged(entries);
    }
  }

  private objectKeyRoot(): string {
    const shards = this.shardCount;
    return [
      "runtime-cache",
      this.getVersionId(),
      STORAGE_LAYOUT_VERSION,
      ...(shards === 1 ? [] : [`shards-${shards}`]),
    ].join("/");
  }

  private objectKeyPrefix(keyHash: string): string {
    return `${this.objectKeyRoot()}/${keyHash}`;
  }

  private r2ObjectKey(keyHash: string): string {
    return `${this.objectKeyPrefix(keyHash)}/active`;
  }

  private entryFromR2Metadata(
    keyHash: string,
    cacheKey: string,
    object: R2Object | null,
  ): StoredEntry | null {
    const metadata = object?.customMetadata;
    if (!metadata || metadata.tombstoned === "1") return null;

    const latestRevision = metadataInteger(metadata.latestRevision);
    const freshUntil = metadataInteger(metadata.freshUntil);
    const swrUntil = metadataInteger(metadata.swrUntil);
    const responseMetadataBytes = metadataInteger(metadata.responseMetadataBytes);
    const responseHeaders = metadataJson(metadata.responseHeaders);
    const hasResponseMetadataPrefix =
      responseMetadataBytes !== undefined &&
      responseMetadataBytes > 0 &&
      responseMetadataBytes <= object.size;
    if (
      latestRevision === undefined ||
      freshUntil === undefined ||
      swrUntil === undefined ||
      (!hasResponseMetadataPrefix &&
        (typeof metadata.statusText !== "string" || !isHeaderEntries(responseHeaders)))
    ) {
      return null;
    }

    return {
      keyHash,
      cacheKey,
      objectKey: this.r2ObjectKey(keyHash),
      statusText: hasResponseMetadataPrefix ? "" : metadata.statusText!,
      responseHeaders: hasResponseMetadataPrefix ? [] : (responseHeaders as [string, string][]),
      freshUntil,
      swrUntil,
      revalidator: null,
      cacheTags: [],
      activeRevision: latestRevision,
      latestRevision,
    };
  }

  private async readR2Metadata(cacheKey: CacheKey): Promise<{
    entry: StoredEntry | null;
    object?: R2ObjectBody;
  }> {
    const object = await this.env.CACHE_BODIES.get(this.r2ObjectKey(cacheKey.keyHash));
    const entry = this.entryFromR2Metadata(cacheKey.keyHash, cacheKey.cacheKey, object);
    if (!entry && object) {
      await object.body.cancel();
    }
    return { entry, ...(entry && object ? { object } : {}) };
  }

  private async readR2MetadataCached(cacheKey: CacheKey): Promise<{
    entry: StoredEntry | null;
    object?: R2ObjectBody;
  }> {
    const readKey = this.entryReadKey(cacheKey.keyHash);
    if (entryReads.has(readKey)) return { entry: null };

    const existing = pendingR2Reads.get(readKey);
    if (existing && !(await existing)) return { entry: null };

    const read = this.readR2Metadata(cacheKey);
    if (existing) return read;

    let pending!: Promise<boolean>;
    pending = read.then(
      ({ entry }) => {
        if (!entry && pendingR2Reads.get(readKey) === pending) {
          entryReads.add(readKey);
        }
        return entry !== null;
      },
      () => true,
    );
    pendingR2Reads.set(readKey, pending);
    try {
      return await read;
    } finally {
      if (pendingR2Reads.get(readKey) === pending) pendingR2Reads.delete(readKey);
    }
  }

  private async writeR2Revision(
    objectKey: string,
    revision: number,
    body: ArrayBuffer | Uint8Array,
    customMetadata: Record<string, string>,
    expectedEtag?: string | null,
  ): Promise<boolean> {
    let etag: string | null | undefined = expectedEtag;

    // A conditional PUT can lose to another revision between HEAD and PUT.
    // Retry against the winner's ETag, but never spin indefinitely under load.
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt++) {
      if (etag === undefined) {
        const current = await this.env.CACHE_BODIES.head(objectKey);
        const currentRevision = metadataInteger(current?.customMetadata?.latestRevision);
        if (currentRevision !== undefined && currentRevision >= revision) return false;
        etag = current?.etag ?? null;
      }

      const stored = await this.env.CACHE_BODIES.put(objectKey, body, {
        onlyIf: etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: etag },
        customMetadata,
      });
      if (stored) return true;
      etag = undefined;
    }

    const current = await this.env.CACHE_BODIES.head(objectKey);
    const currentRevision = metadataInteger(current?.customMetadata?.latestRevision);
    if (currentRevision !== undefined && currentRevision >= revision) return false;
    throw new Error(`R2 revision ${revision} could not be published after concurrent writes`);
  }

  private async writeR2Response(
    entry: StoredEntry,
    body: ArrayBuffer,
    status: number,
    createdAt: number,
    initialAge: number,
    expectedEtag?: string | null,
  ): Promise<boolean> {
    this.invalidateEntryRead(entry.keyHash);
    try {
      const responseHeaders = JSON.stringify(entry.responseHeaders);
      let storedBody: ArrayBuffer | Uint8Array = body;
      let customMetadata: Record<string, string> = {
        status: String(status),
        createdAt: String(createdAt),
        initialAge: String(initialAge),
        statusText: entry.statusText,
        responseHeaders,
        freshUntil: String(entry.freshUntil),
        swrUntil: String(entry.swrUntil),
        latestRevision: String(entry.activeRevision),
      };
      if (customMetadataSize(customMetadata) > R2_CUSTOM_METADATA_SAFE_BYTES) {
        const responseMetadata = new TextEncoder().encode(
          JSON.stringify({ statusText: entry.statusText, responseHeaders: entry.responseHeaders }),
        );
        const envelope = new Uint8Array(responseMetadata.byteLength + body.byteLength);
        envelope.set(responseMetadata);
        envelope.set(new Uint8Array(body), responseMetadata.byteLength);
        storedBody = envelope;
        customMetadata = {
          status: String(status),
          createdAt: String(createdAt),
          initialAge: String(initialAge),
          responseMetadataBytes: String(responseMetadata.byteLength),
          freshUntil: String(entry.freshUntil),
          swrUntil: String(entry.swrUntil),
          latestRevision: String(entry.activeRevision),
        };
      }
      return await this.writeR2Revision(
        this.r2ObjectKey(entry.keyHash),
        entry.activeRevision,
        storedBody,
        customMetadata,
        expectedEtag,
      );
    } finally {
      this.invalidateEntryRead(entry.keyHash);
    }
  }

  private readableEntry(entry: StoredEntry | null): StoredEntry | null {
    return entry ? { ...entry, cacheTags: [], objectKey: this.r2ObjectKey(entry.keyHash) } : entry;
  }

  private async reserveWrite(
    metadata: CacheMetadataStub,
    cacheKey: CacheKey,
    cacheTags: string[],
  ): Promise<WriteReservation> {
    const reservation = await metadata.reserveWrite(
      cacheKey.keyHash,
      cacheKey.cacheKey,
      this.objectKeyPrefix(cacheKey.keyHash),
      Date.now(),
    );
    return { ...cacheKey, fenceTags: cacheTags, ...reservation };
  }

  private logCleanupFailure(objectKey: string, error: unknown): void {
    console.error(
      JSON.stringify({
        message: "Workers Response Store R2 cleanup failed",
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async releaseFailedWrite(
    metadata: CacheMetadataStub,
    write: Pick<WriteReservation, "claimId" | "keyHash" | "objectKey">,
  ): Promise<void> {
    await metadata
      .releaseWrite(write.keyHash, write.objectKey, write.claimId)
      .catch((error) => this.logCleanupFailure(write.objectKey, error));
  }

  private createStoredResponse(
    entry: StoredEntry,
    body: BodyInit | null,
    status: number,
    createdAt: number,
    initialAge: number,
    now = Date.now(),
  ): Response {
    const headers = new Headers(entry.responseHeaders);
    headers.set(AGE_BASIS_HEADER, `${createdAt}:${initialAge}`);
    headers.set("Age", String(representationAge(createdAt, initialAge, now)));
    headers.set(
      "Cloudflare-CDN-Cache-Control",
      edgeCacheControl(entry.freshUntil, entry.swrUntil, now),
    );
    headers.set("Cache-Tag", cacheTagHeader(entry));
    headers.set("X-Workers-Response-Store", now < entry.freshUntil ? "BLOB-FRESH" : "BLOB-STALE");
    headers.set("X-Workers-Response-Store-Revision", String(entry.activeRevision));
    headers.set("X-Workers-Response-Store-Binding-Invocation", crypto.randomUUID());

    return new Response(body, {
      status,
      statusText: entry.statusText,
      headers,
    });
  }

  private async readStoredResponse(
    entry: StoredEntry,
    now = Date.now(),
    prefetchedObject?: R2ObjectBody,
  ): Promise<Response | null> {
    const object = prefetchedObject ?? (await this.env.CACHE_BODIES.get(entry.objectKey));
    if (!object) {
      return null;
    }

    const status = metadataInteger(object.customMetadata?.status);
    const createdAt = metadataInteger(object.customMetadata?.createdAt);
    const initialAge = metadataInteger(object.customMetadata?.initialAge);
    if (
      status === undefined ||
      status < 200 ||
      status > 599 ||
      createdAt === undefined ||
      initialAge === undefined
    ) {
      await object.body.cancel();
      return null;
    }

    let storedEntry = entry;
    let storedBody = object.body;
    const responseMetadataBytes = metadataInteger(object.customMetadata?.responseMetadataBytes);
    if (responseMetadataBytes !== undefined) {
      try {
        const { prefix, remainder } = await readBodyPrefix(storedBody, responseMetadataBytes);
        const responseMetadata = metadataJson(new TextDecoder().decode(prefix));
        if (
          typeof responseMetadata !== "object" ||
          responseMetadata === null ||
          !("statusText" in responseMetadata) ||
          typeof responseMetadata.statusText !== "string" ||
          !("responseHeaders" in responseMetadata) ||
          !isHeaderEntries(responseMetadata.responseHeaders)
        ) {
          await remainder.cancel();
          return null;
        }
        storedEntry = {
          ...entry,
          statusText: responseMetadata.statusText,
          responseHeaders: responseMetadata.responseHeaders,
        };
        storedBody = remainder;
      } catch {
        await storedBody.cancel().catch(() => {});
        return null;
      }
    }

    const body = NULL_BODY_STATUSES.has(status) ? null : storedBody;
    if (!body) await storedBody.cancel();
    return this.createStoredResponse(storedEntry, body, status, createdAt, initialAge, now);
  }

  private async storeResponse(
    metadata: CacheMetadataStub,
    request: Request,
    response: Response,
    revalidator: ResponseStorePutOptions["revalidator"],
    reservation?: WriteReservation,
    cacheTags = cacheTagsFromResponse(response),
    expectedR2Etag?: string | null,
  ): Promise<StoreResult> {
    const cacheKey = reservation ?? (await this.deriveCacheKey(request));
    const write = reservation ?? (await this.reserveWrite(metadata, cacheKey, cacheTags));
    const { keyHash, objectKey: reservationObjectKey, revision } = write;

    let publication: PublicationResult;
    let body: ArrayBuffer;
    let policy: ReturnType<typeof deriveCachePolicy>;
    try {
      const now = Date.now();
      policy = deriveCachePolicy(response.headers, now);
      const responseHeaders = [...response.headers].filter(([name]) => {
        const lower = name.toLowerCase();
        return (
          lower !== "age" &&
          lower !== "cache-tag" &&
          lower !== "cf-cache-status" &&
          lower !== "content-length"
        );
      });
      const candidate: CandidateMetadata = {
        fenceTags: [...new Set([...write.fenceTags, ...cacheTags])],
        objectKey: this.r2ObjectKey(keyHash),
        statusText: response.statusText,
        responseHeaders,
        freshUntil: policy.freshUntil,
        swrUntil: policy.swrUntil,
        revalidator: revalidator ?? null,
        cacheTags,
      };

      // RPC-transferred Response streams do not retain the fixed-length marker
      // required by R2's single-part put API. Materialise only in the cache
      // Worker; bodies are never stored in the metadata Durable Object.
      body = response.body ? await response.arrayBuffer() : new ArrayBuffer(0);
      publication = await metadata.publish(
        keyHash,
        revision,
        candidate,
        write.claimId,
        reservationObjectKey,
      );
    } catch (error) {
      await this.releaseFailedWrite(metadata, write);
      throw error;
    }

    if (!publication.published) {
      return {
        published: false,
        entry: this.readableEntry(publication.entry),
      };
    }

    let stored = false;
    if (publication.entry) {
      try {
        stored = await this.writeR2Response(
          publication.entry,
          body,
          response.status,
          policy.createdAt,
          policy.initialAge,
          expectedR2Etag !== undefined ? expectedR2Etag : write.r2ObjectAbsent ? null : undefined,
        );
      } catch (error) {
        const reconciliation = await metadata
          .invalidatePublishedRevision(publication.entry.keyHash, publication.entry.activeRevision)
          .catch((reconciliationError) => ({
            failures: [
              reconciliationError instanceof Error
                ? reconciliationError.message
                : String(reconciliationError),
            ],
            pending: [],
            purged: [],
          }));
        const reconciliationFailures = reconciliation.failures.map((failure) => new Error(failure));
        if (reconciliation.purged.length) {
          try {
            await this.purgeEdgeCacheByTags(reconciliation.purged.map(purgeTagForEntry));
            await metadata.markTombstonesEdgePurged(reconciliation.purged);
          } catch (reconciliationError) {
            reconciliationFailures.push(
              reconciliationError instanceof Error
                ? reconciliationError
                : new Error(String(reconciliationError)),
            );
          }
        }
        if (reconciliationFailures.length) {
          throw new AggregateError(
            [error, ...reconciliationFailures],
            "R2 response publication and reconciliation failed",
          );
        }
        throw error;
      }
    }

    const entry = this.readableEntry(publication.entry);
    return {
      published: true,
      entry,
      ...(stored && entry
        ? {
            response: this.createStoredResponse(
              entry,
              NULL_BODY_STATUSES.has(response.status) ? null : body,
              response.status,
              policy.createdAt,
              policy.initialAge,
            ),
          }
        : {}),
    };
  }

  private async regenerateEntry(
    metadata: CacheMetadataStub,
    entry: StoredEntry,
    reason: RevalidationReason,
    reservation?: WriteReservation,
    expectedR2Etag?: string | null,
  ): Promise<StoreResult> {
    if (!entry.revalidator) {
      throw new Error("Cache entry has no configured revalidator");
    }

    const cacheRequest = new Request(`https://runtime-cache.invalid${entry.cacheKey}`);
    const writeReservation =
      reservation ??
      (await this.reserveWrite(
        metadata,
        { cacheKey: entry.cacheKey, keyHash: entry.keyHash },
        entry.cacheTags,
      ));

    let response: Response;
    try {
      const origin =
        this.ctx.props?.revalidator ??
        (Reflect.get(this.ctx.exports, "ResponseStoreRevalidator") as
          | RevalidationService
          | undefined);
      if (typeof origin?.regenerate !== "function") {
        throw new Error("The ResponseStoreRevalidator entrypoint is unavailable");
      }
      response = await origin.regenerate({
        request: cacheRequest,
        id: entry.revalidator.id,
        args: entry.revalidator.args,
        reason,
      });
    } catch (error) {
      await this.releaseFailedWrite(metadata, writeReservation);
      throw error;
    }

    return this.storeResponse(
      metadata,
      cacheRequest,
      response,
      entry.revalidator,
      writeReservation,
      undefined,
      expectedR2Etag,
    );
  }

  private async revalidateEntryInBackground(
    metadata: CacheMetadataStub,
    entry: StoredEntry,
    expectedR2Etag?: string | null,
  ): Promise<void> {
    const claim = await metadata.claimRevalidation(
      entry.keyHash,
      entry.activeRevision,
      entry.cacheKey,
      this.objectKeyPrefix(entry.keyHash),
      Date.now(),
      BACKGROUND_REVALIDATION_LEASE_MS,
    );
    if (!claim) {
      return;
    }

    try {
      await this.regenerateEntry(
        metadata,
        claim.entry,
        "swr",
        {
          cacheKey: claim.entry.cacheKey,
          claimId: claim.claimId,
          fenceTags: claim.entry.cacheTags,
          keyHash: claim.entry.keyHash,
          objectKey: claim.objectKey,
          revision: claim.revision,
        },
        expectedR2Etag,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Workers Response Store SWR regeneration failed",
          cacheKey: entry.cacheKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const cacheKey = await this.deriveCacheKey(request);
    const { keyHash } = cacheKey;
    const r2Read = await this.readR2MetadataCached(cacheKey);
    const entry = r2Read.entry;
    const expectedR2Etag = r2Read.object?.etag;
    if (!entry) {
      return new Response("Workers Response Store miss", { status: 404, headers: MISS_HEADERS });
    }

    const now = Date.now();
    if (now < entry.swrUntil) {
      const stored = await this.readStoredResponse(entry, now, r2Read?.object);
      if (stored) {
        if (now < entry.freshUntil) {
          return stored;
        }

        this.ctx.waitUntil(
          Promise.resolve().then(async () => {
            const metadata = this.getMetadata(keyHash);
            await this.revalidateEntryInBackground(metadata, entry, expectedR2Etag);
          }),
        );
        return stored;
      }
    }

    await r2Read?.object?.body.cancel();
    const metadata = this.getMetadata(keyHash);
    const regeneration = await metadata.reserveRegeneration(
      keyHash,
      cacheKey.cacheKey,
      this.objectKeyPrefix(keyHash),
      now,
    );
    if (!regeneration) {
      return new Response("Workers Response Store miss", { status: 404, headers: MISS_HEADERS });
    }
    const regenerated = await this.regenerateEntry(
      metadata,
      regeneration.entry,
      now >= entry.swrUntil ? "expired" : "missing",
      regeneration.reservation
        ? {
            ...cacheKey,
            fenceTags: regeneration.entry.cacheTags,
            ...regeneration.reservation,
          }
        : undefined,
      expectedR2Etag,
    );
    if (!regenerated.entry) {
      throw new Error("Regeneration was superseded and no active entry remains");
    }

    let response = regenerated.response;
    if (!response) {
      const winner = await this.readR2Metadata(cacheKey);
      if (winner.entry) {
        response =
          (await this.readStoredResponse(winner.entry, Date.now(), winner.object)) ?? undefined;
      }
    }
    if (!response) {
      throw new Error("The committed cache body is unavailable");
    }

    return response;
  }

  getTagExpiration(tags: string[]): Promise<number> {
    return this.getTagMetadata(tags).getTagExpiration(tags);
  }

  async put(
    request: Request,
    response: Response,
    options: ResponseStorePutOptions = {},
  ): Promise<ResponseStoreMutationResult> {
    const cacheKey = await this.deriveCacheKey(request);
    const { keyHash } = cacheKey;
    const metadata = this.getMetadata(keyHash);
    const cacheTags = cacheTagsFromResponse(response);
    const pendingPutKey = `${this.getVersionId()}:${this.shardCount}:${keyHash}:${Boolean(options.purgeExisting)}`;
    let reservation: WriteReservation | undefined;
    if (options.coalesce) {
      const pending = pendingPuts.get(pendingPutKey);
      if (pending) {
        reservation ??= await this.reserveWrite(metadata, cacheKey, cacheTags);
        let result: StoreResult | undefined;
        try {
          result = await pending;
        } catch {
          // Preserve this response as the fallback when the leading write fails.
          if (pendingPuts.get(pendingPutKey) === pending) {
            pendingPuts.delete(pendingPutKey);
          }
        }
        if (result?.published && result.entry) {
          const objectKey = reservation.objectKey;
          await metadata
            .finishPendingObjects([objectKey])
            .catch((error) => this.logCleanupFailure(objectKey, error));
          void response.body?.cancel().catch(() => {});
          return {
            backingStoreUpdated: true,
            edgePurgeAccepted: options.purgeExisting
              ? await this.purgeEdgeCacheByTags([purgeTagForEntry(result.entry)])
              : true,
          };
        }
        if (pendingPuts.get(pendingPutKey) === pending) {
          pendingPuts.delete(pendingPutKey);
        }
      }
    }

    const write = (async (): Promise<StoreResult> => {
      reservation ??= await this.reserveWrite(metadata, cacheKey, cacheTags);
      return this.storeResponse(
        metadata,
        request,
        response,
        options.revalidator,
        reservation,
        cacheTags,
      );
    })();
    if (options.coalesce) pendingPuts.set(pendingPutKey, write);
    try {
      const result = await write;
      if (!result.published || !result.entry) {
        return { backingStoreUpdated: false, edgePurgeAccepted: false };
      }
      return {
        backingStoreUpdated: true,
        edgePurgeAccepted: options.purgeExisting
          ? await this.purgeEdgeCacheByTags([purgeTagForEntry(result.entry)])
          : true,
      };
    } finally {
      if (options.coalesce && pendingPuts.get(pendingPutKey) === write) {
        pendingPuts.delete(pendingPutKey);
      }
    }
  }

  async refresh(options: ResponseStoreRefreshOptions): Promise<ResponseStoreMutationResult> {
    if (!options.tags?.length && !options.pathPrefixes?.length) {
      throw new TypeError("refresh() requires tags or pathPrefixes");
    }

    const reserved = await Promise.allSettled(
      this.getMetadataShards().map(async (metadata) => ({
        candidates: await metadata.reserveRefresh(options, this.objectKeyRoot(), Date.now()),
        metadata,
      })),
    );
    const failures: unknown[] = reserved.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    const groups = reserved.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const candidates = groups.flatMap(({ candidates, metadata }) =>
      candidates.map((candidate) => ({ ...candidate, metadata })),
    );
    if (candidates.length === 0) {
      if (failures.length) {
        throw new AggregateError(failures, "One or more cache entries failed to refresh");
      }
      return { backingStoreUpdated: false, edgePurgeAccepted: false };
    }

    const settled = await Promise.allSettled(
      candidates.map(async ({ entry, metadata, reservation }) => {
        const result = await this.regenerateEntry(
          metadata,
          entry,
          "manual",
          reservation
            ? {
                cacheKey: entry.cacheKey,
                fenceTags: entry.cacheTags,
                keyHash: entry.keyHash,
                ...reservation,
              }
            : undefined,
        );
        return result.published ? result.entry : null;
      }),
    );

    const refreshed: StoredEntry[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      } else if (result.value) {
        refreshed.push(result.value);
      }
    }

    const edgePurgeAccepted = refreshed.length
      ? await this.purgeEdgeCacheByTags(refreshed.map((entry) => purgeTagForEntry(entry)))
      : false;

    if (failures.length) {
      throw new AggregateError(failures, "One or more cache entries failed to refresh");
    }

    return {
      backingStoreUpdated: refreshed.length === candidates.length,
      edgePurgeAccepted,
    };
  }

  async purge(options: ResponseStorePurgeOptions): Promise<ResponseStoreMutationResult> {
    if (!options.purgeEverything && !options.tags?.length && !options.pathPrefixes?.length) {
      throw new TypeError("purge() requires tags, pathPrefixes, or purgeEverything");
    }

    const invalidatedAt = Date.now();
    const settled = await Promise.allSettled(
      this.getMetadataShards().map((metadata) => metadata.purgeMatching(options, invalidatedAt)),
    );
    const failures: unknown[] = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    const reservations = settled.flatMap((result, index) =>
      result.status === "fulfilled"
        ? [{ metadata: this.getMetadataShard(index), reservation: result.value }]
        : [],
    );
    for (const { metadata, reservation } of reservations) {
      const batchCount = Math.ceil(reservation.pendingTombstones / PURGE_TOMBSTONE_BATCH_SIZE);
      for (let batch = 0; batch < batchCount; batch++) {
        try {
          const drained = await metadata.drainPendingTombstones(PURGE_TOMBSTONE_BATCH_SIZE);
          failures.push(...drained.failures.map((failure) => new Error(failure)));
        } catch (error) {
          failures.push(error);
        }
      }
    }
    let edgePurgeAccepted = true;

    if (options.purgeEverything) {
      try {
        edgePurgeAccepted = await this.purgeEdgeCache({ purgeEverything: true });
        const acknowledged = await Promise.allSettled(
          reservations.map(({ metadata }) => this.purgePendingEdgeEntries(metadata, false)),
        );
        for (const result of acknowledged) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      } catch (error) {
        edgePurgeAccepted = false;
        failures.push(error);
      }
    } else {
      const acknowledged = await Promise.allSettled(
        reservations.map(({ metadata }) => this.purgePendingEdgeEntries(metadata, true)),
      );
      for (const result of acknowledged) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        } else if (!result.value) {
          edgePurgeAccepted = false;
        }
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, "One or more metadata shards failed to purge");
    }

    return {
      backingStoreUpdated: reservations.some(
        ({ reservation }) => reservation.backingStoreUpdated || reservation.pendingTombstones > 0,
      ),
      edgePurgeAccepted,
    };
  }
}
