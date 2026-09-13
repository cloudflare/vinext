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
  revision: number;
};

type StoreResult = {
  published: boolean;
  entry: StoredEntry | null;
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
const CACHE_PURGE_BATCH_SIZE = 100;
const MAX_CACHE_TAG_HEADER_BYTES = 16 * 1024;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const AGE_BASIS_HEADER = "X-Workers-Response-Store-Age-Basis";
const pendingPuts = new Map<string, Promise<ResponseStoreMutationResult>>();

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

  private objectKeyRoot(): string {
    return ["runtime-cache", this.getVersionId()].join("/");
  }

  private objectKeyPrefix(keyHash: string): string {
    return `${this.objectKeyRoot()}/${keyHash}`;
  }

  private async reserveWrite(
    metadata: CacheMetadataStub,
    keyHash: string,
    cacheKey: string,
    cacheTags: string[],
  ): Promise<WriteReservation> {
    const reservation = await metadata.reserveWrite(
      keyHash,
      cacheKey,
      this.objectKeyPrefix(keyHash),
      Date.now(),
    );
    return { cacheKey, fenceTags: cacheTags, keyHash, ...reservation };
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

  private async readStoredResponse(entry: StoredEntry, now = Date.now()): Promise<Response | null> {
    const object = await this.env.CACHE_BODIES.get(entry.objectKey);
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
    cacheTags = cacheTagsFromResponse(response),
  ): Promise<StoreResult> {
    const cacheKey = reservation ?? (await this.deriveCacheKey(request));
    const write =
      reservation ??
      (await this.reserveWrite(metadata, cacheKey.keyHash, cacheKey.cacheKey, cacheTags));
    const { keyHash, objectKey, revision } = write;

    let publication: PublicationResult;
    try {
      const now = Date.now();
      const policy = deriveCachePolicy(response.headers, now);
      const responseHeaders = [...response.headers].filter(([name]) => {
        const lower = name.toLowerCase();
        return lower !== "age" && lower !== "cf-cache-status" && lower !== "content-length";
      });
      const candidate: CandidateMetadata = {
        fenceTags: [...new Set([...write.fenceTags, ...cacheTags])],
        objectKey,
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
      const body = response.body ? await response.arrayBuffer() : new ArrayBuffer(0);
      await this.env.CACHE_BODIES.put(objectKey, body, {
        customMetadata: {
          status: String(response.status),
          createdAt: String(policy.createdAt),
          initialAge: String(policy.initialAge),
        },
      });

      publication = await metadata.publish(keyHash, revision, candidate, write.claimId);
    } catch (error) {
      await this.releaseFailedWrite(metadata, write);
      throw error;
    }

    if (!publication.published) {
      return { published: false, entry: publication.entry };
    }

    return { published: true, entry: publication.entry };
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

    const cacheRequest = new Request(`https://runtime-cache.invalid${entry.cacheKey}`);
    const writeReservation =
      reservation ??
      (await this.reserveWrite(metadata, entry.keyHash, entry.cacheKey, entry.cacheTags));

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
      this.objectKeyPrefix(entry.keyHash),
      Date.now(),
      BACKGROUND_REVALIDATION_LEASE_MS,
    );
    if (!claim) {
      return;
    }

    try {
      await this.regenerateEntry(metadata, entry, "swr", {
        cacheKey: entry.cacheKey,
        claimId: claim.claimId,
        fenceTags: entry.cacheTags,
        keyHash: entry.keyHash,
        objectKey: claim.objectKey,
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

    const { cacheKey, keyHash } = await this.deriveCacheKey(request);
    const cacheTags = cacheTagsFromResponse(response);
    const pendingPutKey = `${this.getVersionId()}:${keyHash}:${Boolean(options.purgeExisting)}`;
    let reservation: WriteReservation | undefined;
    if (options.coalesce) {
      for (;;) {
        const pending = pendingPuts.get(pendingPutKey);
        if (!pending) break;

        reservation ??= await this.reserveWrite(metadata, keyHash, cacheKey, cacheTags);
        try {
          const result = await pending;
          if (result.backingStoreUpdated) {
            await metadata.finishPendingObjects([reservation.objectKey]);
            await response.body?.cancel().catch(() => {});
            return result;
          }
        } catch {
          // Preserve this response as the fallback when the leading write fails.
        }
        if (pendingPuts.get(pendingPutKey) === pending) {
          pendingPuts.delete(pendingPutKey);
        }
      }
    }

    const write = (async (): Promise<ResponseStoreMutationResult> => {
      reservation ??= await this.reserveWrite(metadata, keyHash, cacheKey, cacheTags);
      const result = await this.storeResponse(
        metadata,
        request,
        response,
        options.revalidator,
        reservation,
        cacheTags,
      );
      if (!result.published || !result.entry) {
        return { backingStoreUpdated: false, edgePurgeAccepted: false };
      }

      const edgePurgeAccepted = options.purgeExisting
        ? await this.purgeEdgeCacheByTags([purgeTagForEntry(result.entry)])
        : true;

      return { backingStoreUpdated: true, edgePurgeAccepted };
    })();
    if (!options.coalesce) return write;

    pendingPuts.set(pendingPutKey, write);
    try {
      return await write;
    } finally {
      if (pendingPuts.get(pendingPutKey) === write) {
        pendingPuts.delete(pendingPutKey);
      }
    }
  }

  async refresh(options: ResponseStoreRefreshOptions): Promise<ResponseStoreMutationResult> {
    if (!options.tags?.length && !options.pathPrefixes?.length) {
      throw new TypeError("refresh() requires tags or pathPrefixes");
    }

    const metadata = this.getMetadata();
    const candidates = await metadata.reserveRefresh(options, this.objectKeyRoot(), Date.now());
    if (candidates.length === 0) {
      return { backingStoreUpdated: false, edgePurgeAccepted: false };
    }

    const settled = await Promise.allSettled(
      candidates.map(async ({ entry, reservation }) => {
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
      backingStoreUpdated: refreshed.length === candidates.length,
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

    return { backingStoreUpdated: true, edgePurgeAccepted };
  }
}
