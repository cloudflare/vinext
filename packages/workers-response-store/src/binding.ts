import { WorkerEntrypoint } from "cloudflare:workers";

import { deriveCachePolicy, edgeCacheControl, representationAge } from "./cache-policy";
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
  status: number;
  createdAt: number;
  initialAge: number;
  responseMetadataInR2?: true;
};

export type StoredEntry = EntryMetadata & {
  keyHash: string;
  cacheKey: string;
  activeRevision: number;
  latestRevision: number;
  legacyResponseMetadata?: {
    status: number;
    createdAt: number;
    initialAge: number;
  };
};

export type PurgedEntry = {
  keyHash: string;
  cacheKey: string;
  objectKey: string;
};

export type RevalidationService = {
  regenerate(input: RevalidationInput): Promise<Response>;
};

type CacheKey = {
  cacheKey: string;
  keyHash: string;
};

type WriteReservation = CacheKey & {
  revision: number;
};

type StoreResult = {
  published: boolean;
  entry: StoredEntry | null;
};

type PublicationResult = {
  published: boolean;
  previousObjectKey?: string;
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
};

export type ResponseStoreServiceProps = Pick<WorkersResponseStoreProps, "locationHint">;

export type ResponseStoreServiceInvocation = {
  versionId: string;
  revalidator: RevalidationService;
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
const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
const ORPHAN_CLEANUP_LIMIT = 100;
const R2_DELETE_BATCH_SIZE = 1_000;
const CACHE_PURGE_BATCH_SIZE = 100;
const MAX_CACHE_TAG_HEADER_BYTES = 16 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const AGE_BASIS_HEADER = "X-Workers-Response-Store-Age-Basis";

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

export class ResponseStoreBinding extends WorkerEntrypoint<
  WorkersResponseStoreEnv,
  WorkersResponseStoreProps
> {
  private getVersionId(): string {
    const versionId = this.ctx.props?.versionId ?? this.env.CF_VERSION_METADATA?.id;
    if (!versionId) {
      throw new Error("Workers Response Store requires a version_metadata binding");
    }

    return versionId;
  }

  private getMetadata(): CacheMetadataStub {
    const locationHint = this.ctx.props?.locationHint;

    return this.env.CACHE_METADATA.getByName(
      this.getVersionId(),
      locationHint ? { locationHint } : undefined,
    ) as CacheMetadataStub;
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

  private logCleanupFailure(objectKey: string, error: unknown): void {
    console.error(
      JSON.stringify({
        message: "Workers Response Store R2 cleanup failed",
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async deletePendingObjects(
    metadata: CacheMetadataStub,
    objectKeys: string[],
  ): Promise<void> {
    if (!objectKeys.length) {
      return;
    }

    for (const batch of batches(objectKeys, R2_DELETE_BATCH_SIZE)) {
      try {
        await this.env.CACHE_BODIES.delete(batch);
        await metadata.finishPendingObjects(batch);
      } catch (error) {
        this.logCleanupFailure(batch.join(","), error);
      }
    }
  }

  private async trackPendingObjects(
    metadata: CacheMetadataStub,
    objectKeys: string[],
    createdAt: number,
  ): Promise<void> {
    try {
      await metadata.trackPendingObjects(objectKeys, createdAt);
    } catch (bulkError) {
      try {
        for (const objectKey of objectKeys) {
          await metadata.trackPendingObject(objectKey, createdAt);
        }
      } catch (fallbackError) {
        throw new AggregateError([bulkError, fallbackError], "Failed to track pending R2 objects");
      }
    }
  }

  private async cleanupExpiredPendingObjects(metadata: CacheMetadataStub): Promise<void> {
    try {
      const objectKeys = await metadata.listExpiredPendingObjects(
        Date.now() - ORPHAN_RETENTION_MS,
        ORPHAN_CLEANUP_LIMIT,
      );
      if (!objectKeys.length) {
        return;
      }

      await this.deletePendingObjects(metadata, objectKeys);
    } catch (error) {
      this.logCleanupFailure("expired-pending-objects", error);
    }
  }

  private async readStoredResponse(entry: StoredEntry, now = Date.now()): Promise<Response | null> {
    const object = await this.env.CACHE_BODIES.get(entry.objectKey);
    if (!object) {
      return null;
    }

    const status =
      metadataInteger(object.customMetadata?.status) ?? entry.legacyResponseMetadata?.status;
    const createdAt =
      metadataInteger(object.customMetadata?.createdAt) ?? entry.legacyResponseMetadata?.createdAt;
    const initialAge =
      metadataInteger(object.customMetadata?.initialAge) ??
      entry.legacyResponseMetadata?.initialAge;
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

    const headers = new Headers(entry.responseHeaders);
    headers.set(AGE_BASIS_HEADER, `${createdAt}:${initialAge}`);
    headers.set("Age", String(representationAge(createdAt, initialAge, now)));
    headers.set(
      "Cloudflare-CDN-Cache-Control",
      edgeCacheControl(entry.freshUntil, entry.swrUntil, now),
    );
    headers.set("Cache-Tag", cacheTagHeader(entry));
    headers.set("X-Workers-Response-Store", now < entry.freshUntil ? "R2-FRESH" : "R2-STALE");
    headers.set("X-Workers-Response-Store-Revision", String(entry.activeRevision));
    headers.set("X-Workers-Response-Store-Binding-Invocation", crypto.randomUUID());

    const body = NULL_BODY_STATUSES.has(status) ? null : object.body;
    if (!body) {
      await object.body.cancel();
    }

    return new Response(body, {
      status,
      statusText: entry.statusText,
      headers,
    });
  }

  private async storeResponse(
    metadata: CacheMetadataStub,
    request: Request,
    response: Response,
    revalidator: ResponseStorePutOptions["revalidator"],
    reservation?: WriteReservation,
  ): Promise<StoreResult> {
    const { cacheKey, keyHash } = reservation ?? (await this.deriveCacheKey(request));
    const revision = reservation?.revision ?? (await metadata.beginWrite(keyHash, cacheKey));

    const objectKey = ["runtime-cache", this.getVersionId(), keyHash, String(revision)].join("/");

    const now = Date.now();
    const policy = deriveCachePolicy(response.headers, now);
    const responseHeaders = [...response.headers].filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== "age" && lower !== "cf-cache-status" && lower !== "content-length";
    });
    const responseCacheTags = [
      ...new Set(
        (response.headers.get("Cache-Tag") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];

    const candidate: CandidateMetadata = {
      objectKey,
      status: response.status,
      statusText: response.statusText,
      responseHeaders,
      createdAt: policy.createdAt,
      initialAge: policy.initialAge,
      freshUntil: policy.freshUntil,
      swrUntil: policy.swrUntil,
      revalidator: revalidator ?? null,
      cacheTags: responseCacheTags,
      // Keep the scalar values in the RPC payload so an older DO can still
      // publish during a rolling deployment. The marker tells the current DO
      // not to duplicate them in SQLite.
      responseMetadataInR2: true,
    };

    await this.trackPendingObjects(metadata, [objectKey], now);

    try {
      // RPC-transferred Response streams do not retain the fixed-length marker
      // required by R2's single-part put API. Materialise only in the cache
      // Worker; bodies are never stored in the metadata Durable Object.
      const body = response.body ? await response.arrayBuffer() : new ArrayBuffer(0);
      await this.env.CACHE_BODIES.put(objectKey, body, {
        customMetadata: {
          status: String(response.status),
          createdAt: String(policy.createdAt),
          initialAge: String(policy.initialAge),
        },
      });
    } catch (error) {
      await this.deletePendingObjects(metadata, [objectKey]);
      throw error;
    }

    let publication: PublicationResult;
    try {
      publication = await metadata.publish(keyHash, revision, candidate);
    } catch (error) {
      await this.deletePendingObjects(metadata, [objectKey]);
      throw error;
    }

    if (!publication.published) {
      await this.deletePendingObjects(metadata, [objectKey]);
      return { published: false, entry: await metadata.getEntry(keyHash) };
    }

    await metadata
      .finishPendingObjects([objectKey])
      .catch((error) => this.logCleanupFailure(objectKey, error));

    const previousObjectKey = publication.previousObjectKey;
    if (previousObjectKey && previousObjectKey !== objectKey) {
      await this.trackPendingObjects(metadata, [previousObjectKey], Date.now()).catch((error) =>
        this.logCleanupFailure(previousObjectKey, error),
      );
      await this.deletePendingObjects(metadata, [previousObjectKey]);
    }

    return { published: true, entry: await metadata.getEntry(keyHash) };
  }

  private async regenerateEntry(
    metadata: CacheMetadataStub,
    entry: StoredEntry,
    reason: RevalidationReason,
    reservation?: WriteReservation,
  ): Promise<StoreResult> {
    if (!entry.revalidator) {
      throw new Error("Cache entry has no configured revalidator");
    }

    const origin =
      this.ctx.props?.revalidator ??
      (Reflect.get(this.ctx.exports, "ResponseStoreRevalidator") as
        | RevalidationService
        | undefined);
    if (typeof origin?.regenerate !== "function") {
      throw new Error("The ResponseStoreRevalidator entrypoint is unavailable");
    }

    const cacheRequest = new Request(`https://runtime-cache.invalid${entry.cacheKey}`);
    const writeReservation = reservation ?? {
      cacheKey: entry.cacheKey,
      keyHash: entry.keyHash,
      revision: await metadata.beginWrite(entry.keyHash, entry.cacheKey),
    };

    const response = await origin.regenerate({
      request: cacheRequest,
      id: entry.revalidator.id,
      args: entry.revalidator.args,
      reason,
    });

    return this.storeResponse(
      metadata,
      cacheRequest,
      response,
      entry.revalidator,
      writeReservation,
    );
  }

  private async revalidateEntryInBackground(
    metadata: CacheMetadataStub,
    entry: StoredEntry,
  ): Promise<void> {
    if (!entry.revalidator) {
      return;
    }

    const claim = await metadata.claimRevalidation(
      entry.keyHash,
      entry.activeRevision,
      entry.cacheKey,
      Date.now(),
      BACKGROUND_REVALIDATION_LEASE_MS,
    );
    if (!claim) {
      return;
    }

    try {
      await this.regenerateEntry(metadata, entry, "swr", {
        cacheKey: entry.cacheKey,
        keyHash: entry.keyHash,
        revision: claim.revision,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Workers Response Store SWR regeneration failed",
          cacheKey: entry.cacheKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      await metadata.finishRevalidation(entry.keyHash, claim.claimId);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { keyHash } = await this.deriveCacheKey(request);
    const metadata = this.getMetadata();
    const entry = await metadata.getEntry(keyHash);
    if (!entry) {
      return new Response("Workers Response Store miss", { status: 404, headers: MISS_HEADERS });
    }

    const now = Date.now();
    if (now < entry.swrUntil) {
      const stored = await this.readStoredResponse(entry, now);
      if (stored) {
        if (now < entry.freshUntil) {
          return stored;
        }

        this.ctx.waitUntil(this.revalidateEntryInBackground(metadata, entry));
        return stored;
      }
    }

    const regenerated = await this.regenerateEntry(
      metadata,
      entry,
      now >= entry.swrUntil ? "expired" : "missing",
    );
    if (!regenerated.entry) {
      throw new Error("Regeneration was superseded and no active entry remains");
    }

    const response = await this.readStoredResponse(regenerated.entry);
    if (!response) {
      throw new Error("The committed cache body is unavailable");
    }

    return response;
  }

  getTagExpiration(tags: string[]): Promise<number> {
    return this.getMetadata().getTagExpiration(tags);
  }

  async put(
    request: Request,
    response: Response,
    options: ResponseStorePutOptions = {},
  ): Promise<ResponseStoreMutationResult> {
    const metadata = this.getMetadata();
    this.ctx.waitUntil(this.cleanupExpiredPendingObjects(metadata));

    const result = await this.storeResponse(metadata, request, response, options.revalidator);
    if (!result.published || !result.entry) {
      return { backingStoreUpdated: false, edgePurgeAccepted: false };
    }

    const edgePurgeAccepted = options.purgeExisting
      ? await this.purgeEdgeCacheByTags([purgeTagForEntry(result.entry)])
      : true;

    return { backingStoreUpdated: true, edgePurgeAccepted };
  }

  async refresh(options: ResponseStoreRefreshOptions): Promise<ResponseStoreMutationResult> {
    if (!options.tags?.length && !options.pathPrefixes?.length) {
      throw new TypeError("refresh() requires tags or pathPrefixes");
    }

    const metadata = this.getMetadata();
    const activeEntries = await metadata.getEntriesMatching(options);
    if (activeEntries.length === 0) {
      return { backingStoreUpdated: false, edgePurgeAccepted: false };
    }

    const settled = await Promise.allSettled(
      activeEntries.map(async (entry) => {
        const result = await this.regenerateEntry(metadata, entry, "manual");
        return result.published ? result.entry : null;
      }),
    );

    const refreshed: StoredEntry[] = [];
    const failures: unknown[] = [];

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
      backingStoreUpdated: refreshed.length === activeEntries.length,
      edgePurgeAccepted,
    };
  }

  async purge(options: ResponseStorePurgeOptions): Promise<ResponseStoreMutationResult> {
    if (!options.purgeEverything && !options.tags?.length && !options.pathPrefixes?.length) {
      throw new TypeError("purge() requires tags, pathPrefixes, or purgeEverything");
    }

    const metadata = this.getMetadata();
    const purged = await metadata.purgeMatching(options);
    let edgePurgeAccepted = true;

    if (options.purgeEverything) {
      edgePurgeAccepted = await this.purgeEdgeCache({ purgeEverything: true });
    } else if (purged.length) {
      edgePurgeAccepted = await this.purgeEdgeCacheByTags(
        purged.map((entry) => purgeTagForEntry(entry)),
      );
    }

    if (purged.length > 0) {
      const objectKeys = purged.map((entry) => entry.objectKey);
      await this.trackPendingObjects(metadata, objectKeys, Date.now());
      await this.deletePendingObjects(metadata, objectKeys);
    }

    return { backingStoreUpdated: true, edgePurgeAccepted };
  }
}
