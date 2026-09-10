import { DurableObject } from "cloudflare:workers";

import type {
  CandidateMetadata,
  PurgedEntry,
  ResponseStoreRefreshOptions,
  ResponseStorePurgeOptions,
  SerializableValue,
  StoredEntry,
} from "./binding";

type RevalidationClaim = {
  claimId: string;
  objectKey: string;
  revision: number;
};

type PublicationResult = {
  entry: StoredEntry | null;
  published: boolean;
  previousObjectKey?: string;
};

type WriteReservation = {
  objectKey: string;
  revision: number;
};

export type CacheMetadataStub = DurableObjectStub & {
  beginWrite(keyHash: string, cacheKey: string): Promise<number>;
  reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<WriteReservation>;
  claimRevalidation(
    keyHash: string,
    activeRevision: number,
    cacheKey: string,
    objectKeyPrefix: string,
    now: number,
    leaseMs: number,
  ): Promise<RevalidationClaim | null>;
  finishRevalidation(keyHash: string, claimId: string): Promise<void>;
  trackPendingObject(objectKey: string, createdAt: number): Promise<void>;
  trackPendingObjects(objectKeys: string[], createdAt: number): Promise<void>;
  finishPendingObjects(objectKeys: string[]): Promise<void>;
  listExpiredPendingObjects(cutoff: number, limit: number): Promise<string[]>;
  sweepExpiredPendingObjects(cutoff?: number): Promise<number>;
  publish(
    keyHash: string,
    revision: number,
    metadata: CandidateMetadata,
  ): Promise<PublicationResult>;
  getEntry(keyHash: string): Promise<StoredEntry | null>;
  getLatestTagExpiration(): Promise<number>;
  getTagExpiration(tags: string[]): Promise<number>;
  getEntriesMatching(options: ResponseStoreRefreshOptions): Promise<StoredEntry[]>;
  purgeMatching(options: ResponseStorePurgeOptions): Promise<PurgedEntry[]>;
  inspect(): Promise<StoredEntry[]>;
};

type EntryRow = Record<string, SqlStorageValue> & {
  key_hash: string;
  cache_key: string;
  active_revision: number | null;
  latest_revision: number;
  object_key: string | null;
  status: number | null;
  status_text: string | null;
  response_headers: string | null;
  created_at: number | null;
  initial_age: number | null;
  fresh_until: number | null;
  swr_until: number | null;
  revalidator_id: string | null;
  revalidator_args: string | null;
  cache_tags: string | null;
  tombstoned: number;
};

const MAX_SQL_PARAMETERS = 100;
const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
const ORPHAN_CLEANUP_LIMIT = 100;

type CacheMetadataEnv = {
  CACHE_BODIES: R2Bucket;
};

function normalizeTags(tags: string[]): string[] {
  const normalized = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(normalized)];
}

function storedEntryFromRow(row: EntryRow): StoredEntry | null {
  if (
    row.tombstoned ||
    row.active_revision === null ||
    row.object_key === null ||
    row.response_headers === null ||
    row.fresh_until === null ||
    row.swr_until === null
  ) {
    return null;
  }

  const entry: StoredEntry = {
    keyHash: row.key_hash,
    cacheKey: row.cache_key,
    activeRevision: row.active_revision,
    latestRevision: row.latest_revision,
    objectKey: row.object_key,
    statusText: row.status_text ?? "",
    responseHeaders: JSON.parse(row.response_headers) as [string, string][],
    freshUntil: row.fresh_until,
    swrUntil: row.swr_until,
    revalidator:
      row.revalidator_id === null
        ? null
        : {
            id: row.revalidator_id,
            args: JSON.parse(row.revalidator_args ?? "[]") as SerializableValue[],
          },
    cacheTags: JSON.parse(row.cache_tags ?? "[]") as string[],
  };

  if (row.status !== null && row.created_at !== null && row.initial_age !== null) {
    entry.legacyResponseMetadata = {
      status: row.status,
      createdAt: row.created_at,
      initialAge: row.initial_age,
    };
  }

  return entry;
}

function storedEntriesFromRows(rows: EntryRow[]): StoredEntry[] {
  const entries: StoredEntry[] = [];

  for (const row of rows) {
    const entry = storedEntryFromRow(row);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

export class CacheMetadata extends DurableObject<CacheMetadataEnv> {
  private cleanupAlarmKnown = false;

  constructor(ctx: DurableObjectState, env: CacheMetadataEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          key_hash TEXT PRIMARY KEY,
          cache_key TEXT NOT NULL,
          active_revision INTEGER,
          latest_revision INTEGER NOT NULL,
          object_key TEXT,
          status INTEGER,
          status_text TEXT,
          response_headers TEXT,
          created_at INTEGER,
          initial_age INTEGER,
          fresh_until INTEGER,
          swr_until INTEGER,
          revalidator_id TEXT,
          revalidator_args TEXT,
          cache_tags TEXT,
          tombstoned INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS entries_cache_key ON entries(cache_key);
        CREATE TABLE IF NOT EXISTS revalidation_claims (
          key_hash TEXT PRIMARY KEY,
          active_revision INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          claim_id TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entry_tags (
          tag TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          PRIMARY KEY (tag, key_hash)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS entry_tags_key_hash ON entry_tags(key_hash);
        CREATE TABLE IF NOT EXISTS tag_invalidations (
          tag TEXT PRIMARY KEY,
          invalidated_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS metadata_schema_migrations (
          version INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS pending_objects (
          object_key TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_objects_created_at ON pending_objects(created_at);
      `);
    });
  }

  private async ensureCleanupAlarm(createdAt: number): Promise<void> {
    if (this.cleanupAlarmKnown) return;

    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.ctx.storage.setAlarm(createdAt + ORPHAN_RETENTION_MS);
    }
    this.cleanupAlarmKnown = true;
  }

  private findMatchingEntryRows(options: ResponseStorePurgeOptions): EntryRow[] {
    if (options.purgeEverything) {
      return this.ctx.storage.sql
        .exec<EntryRow>(
          "SELECT * FROM entries WHERE tombstoned = 0 AND active_revision IS NOT NULL",
        )
        .toArray();
    }

    const tags = new Set(normalizeTags(options.tags ?? []));
    const prefixes = options.pathPrefixes ?? [];
    return this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE tombstoned = 0 AND active_revision IS NOT NULL")
      .toArray()
      .filter(
        (row) =>
          prefixes.some((prefix) => row.cache_key.startsWith(prefix)) ||
          normalizeTags(JSON.parse(row.cache_tags ?? "[]") as string[]).some((tag) =>
            tags.has(tag),
          ),
      );
  }

  async trackPendingObjects(objectKeys: string[], createdAt: number): Promise<void> {
    if (!objectKeys.length) {
      return;
    }

    this.ctx.storage.transactionSync(() => {
      for (const objectKey of objectKeys) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES (?, ?)",
          objectKey,
          createdAt,
        );
      }
    });
    await this.ensureCleanupAlarm(createdAt);
  }

  trackPendingObject(objectKey: string, createdAt: number): Promise<void> {
    return this.trackPendingObjects([objectKey], createdAt);
  }

  finishPendingObjects(objectKeys: string[]): void {
    if (!objectKeys.length) {
      return;
    }

    this.ctx.storage.transactionSync(() => {
      for (const objectKey of objectKeys) {
        this.ctx.storage.sql.exec("DELETE FROM pending_objects WHERE object_key = ?", objectKey);
      }
    });
  }

  listExpiredPendingObjects(cutoff: number, limit: number): string[] {
    return this.ctx.storage.sql
      .exec<{ object_key: string }>(
        `SELECT pending_objects.object_key FROM pending_objects
        LEFT JOIN entries
          ON entries.object_key = pending_objects.object_key AND entries.tombstoned = 0
        WHERE pending_objects.created_at <= ? AND entries.object_key IS NULL
        ORDER BY pending_objects.created_at
        LIMIT ?`,
        cutoff,
        limit,
      )
      .toArray()
      .map((row) => row.object_key);
  }

  async sweepExpiredPendingObjects(cutoff = Date.now() - ORPHAN_RETENTION_MS): Promise<number> {
    const objectKeys = this.listExpiredPendingObjects(cutoff, ORPHAN_CLEANUP_LIMIT);
    if (objectKeys.length) {
      await this.env.CACHE_BODIES.delete(objectKeys);
      this.finishPendingObjects(objectKeys);
    }

    this.cleanupAlarmKnown = false;
    const next = this.ctx.storage.sql
      .exec<{ created_at: number | null }>(
        `SELECT MIN(pending_objects.created_at) AS created_at FROM pending_objects
        LEFT JOIN entries
          ON entries.object_key = pending_objects.object_key AND entries.tombstoned = 0
        WHERE entries.object_key IS NULL`,
      )
      .one().created_at;
    if (objectKeys.length === ORPHAN_CLEANUP_LIMIT) {
      await this.ctx.storage.setAlarm(Date.now());
      this.cleanupAlarmKnown = true;
    } else if (next !== null) {
      await this.ensureCleanupAlarm(next);
    }

    return objectKeys.length;
  }

  async alarm(): Promise<void> {
    await this.sweepExpiredPendingObjects();
  }

  async claimRevalidation(
    keyHash: string,
    activeRevision: number,
    cacheKey: string,
    objectKeyPrefix: string,
    now: number,
    leaseMs: number,
  ): Promise<RevalidationClaim | null> {
    const claim = this.ctx.storage.transactionSync(() => {
      const entry = this.ctx.storage.sql
        .exec<{ active_revision: number | null; latest_revision: number; tombstoned: number }>(
          `SELECT active_revision, latest_revision, tombstoned
          FROM entries WHERE key_hash = ? AND cache_key = ?`,
          keyHash,
          cacheKey,
        )
        .toArray()[0];
      if (entry?.tombstoned || entry?.active_revision !== activeRevision) {
        return null;
      }

      const existing = this.ctx.storage.sql
        .exec<{ active_revision: number; expires_at: number }>(
          "SELECT active_revision, expires_at FROM revalidation_claims WHERE key_hash = ?",
          keyHash,
        )
        .toArray()[0];
      if (existing?.active_revision === activeRevision && existing.expires_at > now) {
        return null;
      }

      const revision = entry.latest_revision + 1;
      const claimId = crypto.randomUUID();
      const objectKey = `${objectKeyPrefix}/${revision}`;

      this.ctx.storage.sql.exec(
        "UPDATE entries SET latest_revision = ? WHERE key_hash = ? AND active_revision = ?",
        revision,
        keyHash,
        activeRevision,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO revalidation_claims
          (key_hash, active_revision, revision, claim_id, claimed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
        keyHash,
        activeRevision,
        revision,
        claimId,
        now,
        now + leaseMs,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES (?, ?)",
        objectKey,
        now,
      );

      return { claimId, objectKey, revision };
    });
    if (claim) await this.ensureCleanupAlarm(now);
    return claim;
  }

  finishRevalidation(keyHash: string, claimId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM revalidation_claims WHERE key_hash = ? AND claim_id = ?",
      keyHash,
      claimId,
    );
  }

  private reserveRevision(keyHash: string, cacheKey: string): number {
    const current = this.ctx.storage.sql
      .exec<{ latest_revision: number }>(
        "SELECT latest_revision FROM entries WHERE key_hash = ?",
        keyHash,
      )
      .toArray()[0];
    const revision = (current?.latest_revision ?? 0) + 1;

    if (!current) {
      this.ctx.storage.sql.exec(
        "INSERT INTO entries (key_hash, cache_key, latest_revision, tombstoned) VALUES (?, ?, ?, 1)",
        keyHash,
        cacheKey,
        revision,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE entries SET cache_key = ?, latest_revision = ? WHERE key_hash = ?",
        cacheKey,
        revision,
        keyHash,
      );
    }

    return revision;
  }

  beginWrite(keyHash: string, cacheKey: string): number {
    return this.ctx.storage.transactionSync(() => this.reserveRevision(keyHash, cacheKey));
  }

  async reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<WriteReservation> {
    const reservation = this.ctx.storage.transactionSync(() => {
      const revision = this.reserveRevision(keyHash, cacheKey);
      const objectKey = `${objectKeyPrefix}/${revision}`;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES (?, ?)",
        objectKey,
        createdAt,
      );
      return { objectKey, revision };
    });
    await this.ensureCleanupAlarm(createdAt);
    return reservation;
  }

  publish(keyHash: string, revision: number, metadata: CandidateMetadata): PublicationResult {
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<EntryRow>("SELECT * FROM entries WHERE key_hash = ?", keyHash)
        .toArray()[0];
      if (!current || current.latest_revision !== revision) {
        return { entry: current ? storedEntryFromRow(current) : null, published: false };
      }

      const responseMetadataIsInR2 = metadata.responseMetadataInR2 === true;
      const update = this.ctx.storage.sql.exec(
        `UPDATE entries SET
          active_revision = ?, object_key = ?, status = ?, status_text = ?,
          response_headers = ?, created_at = ?, initial_age = ?, fresh_until = ?, swr_until = ?,
          revalidator_id = ?, revalidator_args = ?, cache_tags = ?, tombstoned = 0
        WHERE key_hash = ? AND latest_revision = ?`,
        revision,
        metadata.objectKey,
        responseMetadataIsInR2 ? null : metadata.status,
        metadata.statusText,
        JSON.stringify(metadata.responseHeaders),
        responseMetadataIsInR2 ? null : metadata.createdAt,
        responseMetadataIsInR2 ? null : metadata.initialAge,
        metadata.freshUntil,
        metadata.swrUntil,
        metadata.revalidator?.id ?? null,
        metadata.revalidator ? JSON.stringify(metadata.revalidator.args) : null,
        JSON.stringify(metadata.cacheTags),
        keyHash,
        revision,
      );

      const published = update.rowsWritten === 1;

      const entry: StoredEntry = {
        keyHash,
        cacheKey: current.cache_key,
        activeRevision: revision,
        latestRevision: revision,
        objectKey: metadata.objectKey,
        statusText: metadata.statusText,
        responseHeaders: metadata.responseHeaders,
        freshUntil: metadata.freshUntil,
        swrUntil: metadata.swrUntil,
        revalidator: metadata.revalidator,
        cacheTags: metadata.cacheTags,
        ...(responseMetadataIsInR2
          ? {}
          : {
              legacyResponseMetadata: {
                status: metadata.status,
                createdAt: metadata.createdAt,
                initialAge: metadata.initialAge,
              },
            }),
      };

      return {
        entry: published ? entry : null,
        published,
        ...(current.object_key ? { previousObjectKey: current.object_key } : {}),
      };
    });
  }

  getEntry(keyHash: string): StoredEntry | null {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE key_hash = ?", keyHash)
      .toArray()[0];
    return row ? storedEntryFromRow(row) : null;
  }

  getTagExpiration(tags: string[]): number {
    const normalized = normalizeTags(tags);
    let expiration = 0;

    for (let offset = 0; offset < normalized.length; offset += MAX_SQL_PARAMETERS) {
      const batch = normalized.slice(offset, offset + MAX_SQL_PARAMETERS);
      const placeholders = batch.map(() => "?").join(", ");
      const row = this.ctx.storage.sql
        .exec<{ invalidated_at: number | null }>(
          `SELECT MAX(invalidated_at) AS invalidated_at
          FROM tag_invalidations WHERE tag IN (${placeholders})`,
          ...batch,
        )
        .one();
      expiration = Math.max(expiration, row.invalidated_at ?? 0);
    }

    return expiration;
  }

  getLatestTagExpiration(): number {
    return (
      this.ctx.storage.sql
        .exec<{ invalidated_at: number | null }>(
          "SELECT MAX(invalidated_at) AS invalidated_at FROM tag_invalidations",
        )
        .one().invalidated_at ?? 0
    );
  }

  getEntriesMatching(options: ResponseStoreRefreshOptions): StoredEntry[] {
    return storedEntriesFromRows(this.findMatchingEntryRows(options));
  }

  purgeMatching(options: ResponseStorePurgeOptions): PurgedEntry[] {
    return this.ctx.storage.transactionSync(() => {
      const matches = this.findMatchingEntryRows(options);
      const invalidatedAt = Date.now();

      for (const tag of normalizeTags(options.tags ?? [])) {
        this.ctx.storage.sql.exec(
          `INSERT INTO tag_invalidations (tag, invalidated_at) VALUES (?, ?)
          ON CONFLICT(tag) DO UPDATE SET invalidated_at =
            MAX(tag_invalidations.invalidated_at, excluded.invalidated_at)`,
          tag,
          invalidatedAt,
        );
      }

      for (const row of matches) {
        this.ctx.storage.sql.exec(
          `UPDATE entries SET
            latest_revision = latest_revision + 1,
            active_revision = NULL,
            object_key = NULL,
            status = NULL,
            status_text = NULL,
            response_headers = NULL,
            created_at = NULL,
            initial_age = NULL,
            fresh_until = NULL,
            swr_until = NULL,
            revalidator_id = NULL,
            revalidator_args = NULL,
            cache_tags = NULL,
            tombstoned = 1
          WHERE key_hash = ?`,
          row.key_hash,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM revalidation_claims WHERE key_hash = ?",
          row.key_hash,
        );
      }

      return matches.map((row) => ({
        keyHash: row.key_hash,
        cacheKey: row.cache_key,
        objectKey: row.object_key!,
      }));
    });
  }

  inspect(): StoredEntry[] {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY cache_key")
      .toArray();
    return storedEntriesFromRows(rows);
  }
}
