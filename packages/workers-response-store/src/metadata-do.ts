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
};

type WriteReservation = {
  coalesced: boolean;
  objectKey: string;
  revision: number;
};

type RefreshCandidate = {
  entry: StoredEntry;
  reservation?: Pick<WriteReservation, "objectKey" | "revision">;
};

export type CacheMetadataStub = DurableObjectStub & {
  beginWrite(keyHash: string, cacheKey: string): Promise<number>;
  reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
    coalesce?: boolean,
  ): Promise<WriteReservation>;
  claimRevalidation(
    keyHash: string,
    activeRevision: number,
    cacheKey: string,
    objectKeyPrefix: string,
    now: number,
    leaseMs: number,
  ): Promise<RevalidationClaim | null>;
  trackPendingObject(objectKey: string, createdAt: number): Promise<void>;
  trackPendingObjects(objectKeys: string[], createdAt: number): Promise<void>;
  releaseWrite(keyHash: string, objectKey: string, claimId?: string): Promise<void>;
  finishPendingObjects(objectKeys: string[]): Promise<void>;
  listExpiredPendingObjects(cutoff: number, limit: number): Promise<string[]>;
  sweepExpiredPendingObjects(cutoff?: number): Promise<number>;
  publish(
    keyHash: string,
    revision: number,
    metadata: CandidateMetadata,
    claimId?: string,
  ): Promise<PublicationResult>;
  getEntry(keyHash: string): Promise<StoredEntry | null>;
  getTagExpiration(tags: string[]): Promise<number>;
  reserveRefresh(
    options: ResponseStoreRefreshOptions,
    objectKeyRoot: string,
    createdAt: number,
  ): Promise<RefreshCandidate[]>;
  purgeMatching(options: ResponseStorePurgeOptions): Promise<PurgedEntry[]>;
  inspect(): Promise<StoredEntry[]>;
};

type EntryRow = Record<string, SqlStorageValue> & {
  key_hash: string;
  cache_key: string;
  active_revision: number | null;
  latest_revision: number;
  object_key: string | null;
  status_text: string | null;
  response_headers: string | null;
  fresh_until: number | null;
  swr_until: number | null;
  revalidator_id: string | null;
  revalidator_args: string | null;
  cache_tags: string | null;
  tombstoned: number;
};

const MAX_SQL_PARAMETERS = 100;
const R2_DELETE_BATCH_SIZE = 1_000;
const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
const ORPHAN_CLEANUP_LIMIT = 100;
const ORPHAN_CLEANUP_RETRY_MS = 60 * 1000;
const WRITE_COALESCE_LEASE_MS = 30_000;

type CacheMetadataEnv = {
  CACHE_BODIES: R2Bucket;
};

function normalizeTags(tags: string[]): string[] {
  const normalized = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(normalized)];
}

function* batches<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size);
  }
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

  return {
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
          status_text TEXT,
          response_headers TEXT,
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
        CREATE TABLE IF NOT EXISTS tag_invalidations (
          tag TEXT PRIMARY KEY,
          invalidated_at INTEGER NOT NULL
        ) WITHOUT ROWID;
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
      for (const batch of batches(objectKeys, MAX_SQL_PARAMETERS / 2)) {
        const values = batch.flatMap((objectKey) => [objectKey, createdAt]);
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES ${batch
            .map(() => "(?, ?)")
            .join(", ")}`,
          ...values,
        );
      }
    });
    await this.ensureCleanupAlarm(createdAt);
  }

  trackPendingObject(objectKey: string, createdAt: number): Promise<void> {
    return this.trackPendingObjects([objectKey], createdAt);
  }

  releaseWrite(keyHash: string, objectKey: string, claimId?: string): void {
    // Keep the object registered for cleanup while expiring its overlap lease.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE pending_objects SET created_at = 0 WHERE object_key = ?",
        objectKey,
      );
      if (claimId) {
        this.ctx.storage.sql.exec(
          "DELETE FROM revalidation_claims WHERE key_hash = ? AND claim_id = ?",
          keyHash,
          claimId,
        );
      }
    });
  }

  finishPendingObjects(objectKeys: string[]): void {
    if (!objectKeys.length) {
      return;
    }

    this.ctx.storage.transactionSync(() => {
      for (const batch of batches(objectKeys, MAX_SQL_PARAMETERS)) {
        this.ctx.storage.sql.exec(
          `DELETE FROM pending_objects WHERE object_key IN (${batch.map(() => "?").join(", ")})`,
          ...batch,
        );
      }
    });
  }

  private async deleteTrackedObjects(objectKeys: string[]): Promise<void> {
    for (const batch of batches(objectKeys, R2_DELETE_BATCH_SIZE)) {
      try {
        await this.env.CACHE_BODIES.delete(batch);
        this.finishPendingObjects(batch);
      } catch (error) {
        console.error(
          JSON.stringify({
            message: "Workers Response Store R2 cleanup failed",
            objectKeys: batch,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
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
    this.cleanupAlarmKnown = false;
    const rows = this.ctx.storage.sql
      .exec<{ active: number; created_at: number; object_key: string }>(
        `SELECT pending_objects.object_key, pending_objects.created_at,
          entries.object_key IS NOT NULL AS active
        FROM pending_objects
        LEFT JOIN entries
          ON entries.object_key = pending_objects.object_key AND entries.tombstoned = 0
        ORDER BY pending_objects.created_at
        LIMIT ?`,
        ORPHAN_CLEANUP_LIMIT + 1,
      )
      .toArray();
    const batch = rows.slice(0, ORPHAN_CLEANUP_LIMIT);
    const activeObjectKeys = batch
      .filter(({ active }) => active)
      .map(({ object_key }) => object_key);
    const expiredObjectKeys = batch
      .filter(({ active, created_at }) => !active && created_at <= cutoff)
      .map(({ object_key }) => object_key);
    this.finishPendingObjects(activeObjectKeys);
    if (expiredObjectKeys.length) {
      await this.env.CACHE_BODIES.delete(expiredObjectKeys);
      this.finishPendingObjects(expiredObjectKeys);
    }

    const next = batch.find(({ active, created_at }) => !active && created_at > cutoff);
    if (!next && rows.length > ORPHAN_CLEANUP_LIMIT) {
      await this.ctx.storage.setAlarm(Date.now());
      this.cleanupAlarmKnown = true;
    } else if (next) {
      await this.ensureCleanupAlarm(next.created_at);
    }

    return expiredObjectKeys.length;
  }

  async alarm(): Promise<void> {
    try {
      await this.sweepExpiredPendingObjects();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "Workers Response Store orphan cleanup failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.ctx.storage.setAlarm(Date.now() + ORPHAN_CLEANUP_RETRY_MS);
      this.cleanupAlarmKnown = true;
    }
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
        .exec<{
          active_revision: number | null;
          latest_revision: number;
          tombstoned: number;
          claim_active_revision: number | null;
          claim_expires_at: number | null;
        }>(
          `SELECT entries.active_revision, entries.latest_revision, entries.tombstoned,
            revalidation_claims.active_revision AS claim_active_revision,
            revalidation_claims.expires_at AS claim_expires_at
          FROM entries
          LEFT JOIN revalidation_claims ON revalidation_claims.key_hash = entries.key_hash
          WHERE entries.key_hash = ? AND entries.cache_key = ?`,
          keyHash,
          cacheKey,
        )
        .toArray()[0];
      if (entry?.tombstoned || entry?.active_revision !== activeRevision) {
        return null;
      }

      if (entry.claim_active_revision === activeRevision && (entry.claim_expires_at ?? 0) > now) {
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

  private reserveRevision(
    keyHash: string,
    cacheKey: string,
    current: { latest_revision: number } | undefined,
  ): number {
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
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<{ latest_revision: number }>(
          "SELECT latest_revision FROM entries WHERE key_hash = ?",
          keyHash,
        )
        .toArray()[0];
      return this.reserveRevision(keyHash, cacheKey, current);
    });
  }

  async reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
    coalesce = false,
  ): Promise<WriteReservation> {
    const reservation = this.ctx.storage.transactionSync(() => {
      const current:
        | {
            active_revision: number | null;
            latest_revision: number;
            write_pending?: number;
          }
        | undefined = coalesce
        ? this.ctx.storage.sql
            .exec<{
              active_revision: number | null;
              latest_revision: number;
              write_pending: number;
            }>(
              `SELECT entries.active_revision, entries.latest_revision,
                pending_objects.object_key IS NOT NULL AS write_pending
              FROM entries
              LEFT JOIN pending_objects ON pending_objects.object_key = ? || '/' || entries.latest_revision
                AND pending_objects.created_at > ?
              WHERE entries.key_hash = ?`,
              objectKeyPrefix,
              createdAt - WRITE_COALESCE_LEASE_MS,
              keyHash,
            )
            .toArray()[0]
        : this.ctx.storage.sql
            .exec<{ active_revision: number | null; latest_revision: number }>(
              "SELECT active_revision, latest_revision FROM entries WHERE key_hash = ?",
              keyHash,
            )
            .toArray()[0];
      if (
        coalesce &&
        current?.active_revision !== current?.latest_revision &&
        current?.write_pending
      ) {
        const objectKey = `${objectKeyPrefix}/${current.latest_revision}`;
        return { coalesced: true, objectKey, revision: current.latest_revision };
      }

      const revision = this.reserveRevision(keyHash, cacheKey, current);
      const objectKey = `${objectKeyPrefix}/${revision}`;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES (?, ?)",
        objectKey,
        createdAt,
      );
      return { coalesced: false, objectKey, revision };
    });
    await this.ensureCleanupAlarm(createdAt);
    return reservation;
  }

  async publish(
    keyHash: string,
    revision: number,
    metadata: CandidateMetadata,
    claimId?: string,
  ): Promise<PublicationResult> {
    const { cleanupObjectKey, result } = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<EntryRow>("SELECT * FROM entries WHERE key_hash = ?", keyHash)
        .toArray()[0];
      if (!current || current.latest_revision !== revision) {
        if (claimId) {
          this.ctx.storage.sql.exec(
            "DELETE FROM revalidation_claims WHERE key_hash = ? AND claim_id = ?",
            keyHash,
            claimId,
          );
        }
        return {
          cleanupObjectKey:
            current?.object_key === metadata.objectKey ? undefined : metadata.objectKey,
          result: { entry: current ? storedEntryFromRow(current) : null, published: false },
        };
      }

      const update = this.ctx.storage.sql.exec(
        `UPDATE entries SET
          active_revision = ?, object_key = ?, status_text = ?, response_headers = ?,
          fresh_until = ?, swr_until = ?,
          revalidator_id = ?, revalidator_args = ?, cache_tags = ?, tombstoned = 0
        WHERE key_hash = ? AND latest_revision = ?`,
        revision,
        metadata.objectKey,
        metadata.statusText,
        JSON.stringify(metadata.responseHeaders),
        metadata.freshUntil,
        metadata.swrUntil,
        metadata.revalidator?.id ?? null,
        metadata.revalidator ? JSON.stringify(metadata.revalidator.args) : null,
        JSON.stringify(metadata.cacheTags),
        keyHash,
        revision,
      );

      const published = update.rowsWritten === 1;
      if (published) {
        this.ctx.storage.sql.exec(
          "DELETE FROM pending_objects WHERE object_key = ?",
          metadata.objectKey,
        );
      }
      if (published && current.object_key && current.object_key !== metadata.objectKey) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO pending_objects (object_key, created_at) VALUES (?, ?)",
          current.object_key,
          Date.now(),
        );
      }
      if (claimId) {
        this.ctx.storage.sql.exec(
          "DELETE FROM revalidation_claims WHERE key_hash = ? AND claim_id = ?",
          keyHash,
          claimId,
        );
      }

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
      };

      return {
        cleanupObjectKey: published
          ? current.object_key && current.object_key !== metadata.objectKey
            ? current.object_key
            : undefined
          : metadata.objectKey,
        result: {
          entry: published ? entry : null,
          published,
        },
      };
    });

    if (cleanupObjectKey) {
      await this.ensureCleanupAlarm(Date.now());
      await this.deleteTrackedObjects([cleanupObjectKey]);
    }
    return result;
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

    for (const batch of batches(normalized, MAX_SQL_PARAMETERS)) {
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

  async reserveRefresh(
    options: ResponseStoreRefreshOptions,
    objectKeyRoot: string,
    createdAt: number,
  ): Promise<RefreshCandidate[]> {
    const candidates = this.ctx.storage.transactionSync(() => {
      const matches = this.findMatchingEntryRows(options);
      const reservations = matches.flatMap((row) => {
        const entry = storedEntryFromRow(row);
        return entry?.revalidator
          ? [
              {
                keyHash: row.key_hash,
                objectKey: `${objectKeyRoot}/${row.key_hash}/${row.latest_revision + 1}`,
                revision: row.latest_revision + 1,
              },
            ]
          : [];
      });

      for (const batch of batches(reservations, MAX_SQL_PARAMETERS)) {
        const keyHashes = batch.map(({ keyHash }) => keyHash);
        this.ctx.storage.sql.exec(
          `UPDATE entries SET latest_revision = latest_revision + 1
          WHERE key_hash IN (${keyHashes.map(() => "?").join(", ")})`,
          ...keyHashes,
        );
      }
      for (const batch of batches(reservations, MAX_SQL_PARAMETERS / 2)) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO pending_objects (object_key, created_at) VALUES ${batch
            .map(() => "(?, ?)")
            .join(", ")}`,
          ...batch.flatMap(({ objectKey }) => [objectKey, createdAt]),
        );
      }

      const byKey = new Map(reservations.map((reservation) => [reservation.keyHash, reservation]));
      return matches.flatMap((row) => {
        const entry = storedEntryFromRow(row);
        if (!entry) return [];
        const reservation = byKey.get(row.key_hash);
        return [
          {
            entry,
            ...(reservation
              ? {
                  reservation: {
                    objectKey: reservation.objectKey,
                    revision: reservation.revision,
                  },
                }
              : {}),
          },
        ];
      });
    });

    if (candidates.some(({ reservation }) => reservation)) {
      await this.ensureCleanupAlarm(createdAt);
    }
    return candidates;
  }

  async purgeMatching(options: ResponseStorePurgeOptions): Promise<PurgedEntry[]> {
    const invalidatedAt = Date.now();
    const matches = this.ctx.storage.transactionSync(() => {
      const matches = this.findMatchingEntryRows(options);

      const tags = normalizeTags(options.tags ?? []);
      for (const batch of batches(tags, MAX_SQL_PARAMETERS / 2)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO tag_invalidations (tag, invalidated_at) VALUES ${batch
            .map(() => "(?, ?)")
            .join(", ")}
          ON CONFLICT(tag) DO UPDATE SET invalidated_at =
            MAX(tag_invalidations.invalidated_at, excluded.invalidated_at)`,
          ...batch.flatMap((tag) => [tag, invalidatedAt]),
        );
      }

      for (const batch of batches(matches, MAX_SQL_PARAMETERS)) {
        const keyHashes = batch.map((row) => row.key_hash);
        const placeholders = keyHashes.map(() => "?").join(", ");
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO pending_objects (object_key, created_at)
          SELECT object_key, ? FROM entries
          WHERE key_hash IN (${placeholders}) AND object_key IS NOT NULL`,
          invalidatedAt,
          ...keyHashes,
        );
        this.ctx.storage.sql.exec(
          `UPDATE entries SET
            latest_revision = latest_revision + 1,
            active_revision = NULL,
            object_key = NULL,
            status_text = NULL,
            response_headers = NULL,
            fresh_until = NULL,
            swr_until = NULL,
            revalidator_id = NULL,
            revalidator_args = NULL,
            cache_tags = NULL,
            tombstoned = 1
          WHERE key_hash IN (${placeholders})`,
          ...keyHashes,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM revalidation_claims WHERE key_hash IN (${placeholders})`,
          ...keyHashes,
        );
      }

      return matches.map((row) => ({
        keyHash: row.key_hash,
        cacheKey: row.cache_key,
        objectKey: row.object_key!,
      }));
    });
    if (matches.length) {
      await this.ensureCleanupAlarm(invalidatedAt);
      await this.deleteTrackedObjects(matches.map((entry) => entry.objectKey));
    }
    return matches;
  }

  inspect(): StoredEntry[] {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY cache_key")
      .toArray();
    return storedEntriesFromRows(rows);
  }
}
