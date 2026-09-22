import { DurableObject } from "cloudflare:workers";

import type {
  CandidateMetadata,
  PurgedEntry,
  ResponseStoreRefreshOptions,
  ResponseStorePurgeOptions,
  SerializableValue,
  StoredEntry,
} from "./binding";
import { mapSettledWithR2Concurrency } from "./r2-concurrency";

type RevalidationClaim = {
  claimId: string;
  entry: StoredEntry;
  objectKey: string;
  revision: number;
};

type PublicationResult = {
  edgePurgeRequired: boolean;
  entry: StoredEntry | null;
  published: boolean;
};

type WriteReservation = {
  objectKey: string;
  r2ObjectAbsent: boolean;
  revision: number;
};

type RefreshCandidate = {
  entry: StoredEntry;
  reservation?: Pick<WriteReservation, "objectKey" | "revision">;
};

type RegenerationReservation = {
  entry: StoredEntry;
  reservation?: WriteReservation;
};

type PurgeReservation = {
  backingStoreUpdated: boolean;
  pendingTombstones: number;
  tombstoneSequence: number;
};

type TombstoneDrainResult = {
  cursor?: string;
  failures: string[];
  pending: PurgedEntry[];
  purged: PurgedEntry[];
};

type R2TombstoneEdgePurger = {
  purgeR2TombstoneEdges(entries: PurgedEntry[]): Promise<boolean>;
};

export type CacheMetadataStub = DurableObjectStub & {
  reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<WriteReservation>;
  replaceFailedWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    failedObjectKey: string,
    fenceTags: string[],
    createdAt: number,
  ): Promise<WriteReservation | null>;
  reserveRegeneration(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<RegenerationReservation | null>;
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
    reservationObjectKey?: string,
  ): Promise<PublicationResult>;
  invalidatePublishedRevision(keyHash: string, revision: number): Promise<TombstoneDrainResult>;
  getEntry(keyHash: string): Promise<StoredEntry | null>;
  getTagExpiration(tags: string[]): Promise<number>;
  reserveRefresh(
    options: ResponseStoreRefreshOptions,
    objectKeyRoot: string,
    createdAt: number,
  ): Promise<RefreshCandidate[]>;
  purgeMatching(
    options: ResponseStorePurgeOptions,
    invalidatedAt?: number,
  ): Promise<PurgeReservation>;
  drainPendingTombstones(
    limit: number,
    keyHash?: string,
    afterKeyHash?: string,
    tombstoneSequence?: number,
  ): Promise<TombstoneDrainResult>;
  retryPendingTombstones(): Promise<boolean>;
  listPendingEdgePurges(limit: number, tombstoneSequence?: number): Promise<PurgedEntry[]>;
  markTombstonesEdgePurged(entries: PurgedEntry[]): Promise<void>;
  markTombstonesEdgePurgedThrough(tombstoneSequence: number): Promise<void>;
  inspect(): Promise<StoredEntry[]>;
};

type EntryRow = Record<string, SqlStorageValue> & {
  key_hash: string;
  cache_key: string;
  active_revision: number | null;
  latest_revision: number;
  object_key: string | null;
  claim_active_revision?: number | null;
  claim_expires_at?: number | null;
  claim_id?: string | null;
  claim_revision?: number | null;
  current_invalidation_sequence?: number;
  pending_invalidation_sequence?: number | null;
  pending_publishable?: number | null;
  status_text: string | null;
  response_headers: string | null;
  fresh_until: number | null;
  swr_until: number | null;
  revalidator_id: string | null;
  revalidator_args: string | null;
  cache_tags: string | null;
  tombstoned: number;
};

type PurgeEntryRow = Pick<EntryRow, "key_hash" | "cache_key" | "latest_revision" | "object_key">;

const MAX_SQL_PARAMETERS = 100;
const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
const ORPHAN_CLEANUP_LIMIT = 100;
const ORPHAN_CLEANUP_RETRY_MS = 60 * 1000;
const MAX_R2_CAS_ATTEMPTS = 3;

type CacheMetadataEnv = {
  CACHE_BODIES: R2Bucket;
};

type PendingTombstoneRow = Record<string, SqlStorageValue> & {
  cache_key: string;
  edge_purge_complete: number;
  key_hash: string;
  object_key: string;
  r2_complete: number;
  revision: number;
};

function metadataInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

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
        CREATE INDEX IF NOT EXISTS entries_active_object_key
          ON entries(object_key) WHERE tombstoned = 0;
        CREATE TABLE IF NOT EXISTS entry_tags (
          tag TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          PRIMARY KEY (tag, key_hash)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS entry_tags_key_hash ON entry_tags(key_hash);
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
          invalidated_at INTEGER NOT NULL,
          invalidation_sequence INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS metadata_schema_migrations (
          version INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS metadata_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          tag_invalidation_sequence INTEGER NOT NULL,
          tombstone_sequence INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO metadata_state (singleton, tag_invalidation_sequence) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS key_invalidations (
          key_hash TEXT PRIMARY KEY,
          invalidation_sequence INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS pending_objects (
          object_key TEXT PRIMARY KEY,
          invalidation_sequence INTEGER NOT NULL DEFAULT 0,
          publishable INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_objects_created_at ON pending_objects(created_at);
        CREATE TABLE IF NOT EXISTS pending_r2_tombstones (
          key_hash TEXT PRIMARY KEY,
          cache_key TEXT NOT NULL,
          object_key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          r2_complete INTEGER NOT NULL DEFAULT 0,
          edge_purge_complete INTEGER NOT NULL DEFAULT 0,
          tombstone_sequence INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
      `);

      ctx.storage.transactionSync(() => {
        const migrations = new Set(
          ctx.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM metadata_schema_migrations WHERE version IN (2, 3, 4, 5, 6)",
            )
            .toArray()
            .map(({ version }) => version),
        );
        if (migrations.size === 5) return;

        const schemas = ctx.storage.sql
          .exec<{ name: string; sql: string }>(
            `SELECT name, sql FROM sqlite_schema
            WHERE type = 'table'
              AND name IN ('tag_invalidations', 'metadata_state', 'pending_objects', 'pending_r2_tombstones')`,
          )
          .toArray();
        if (
          !migrations.has(2) &&
          !schemas
            .find(({ name }) => name === "tag_invalidations")
            ?.sql.includes("invalidation_sequence")
        ) {
          ctx.storage.sql.exec(
            "ALTER TABLE tag_invalidations ADD COLUMN invalidation_sequence INTEGER NOT NULL DEFAULT 0",
          );
        }
        if (
          !migrations.has(2) &&
          !schemas
            .find(({ name }) => name === "pending_objects")
            ?.sql.includes("invalidation_sequence")
        ) {
          ctx.storage.sql.exec(
            "ALTER TABLE pending_objects ADD COLUMN invalidation_sequence INTEGER NOT NULL DEFAULT 0",
          );
        }
        if (!migrations.has(2)) {
          ctx.storage.sql.exec("INSERT INTO metadata_schema_migrations (version) VALUES (2)");
        }
        if (!migrations.has(3)) {
          if (
            !schemas.find(({ name }) => name === "pending_objects")?.sql.includes("publishable")
          ) {
            ctx.storage.sql.exec(
              "ALTER TABLE pending_objects ADD COLUMN publishable INTEGER NOT NULL DEFAULT 1",
            );
          }
          ctx.storage.sql.exec("INSERT INTO metadata_schema_migrations (version) VALUES (3)");
        }
        if (!migrations.has(4)) {
          const tombstones = schemas.find(({ name }) => name === "pending_r2_tombstones")?.sql;
          if (!tombstones?.includes("r2_complete")) {
            ctx.storage.sql.exec(
              "ALTER TABLE pending_r2_tombstones ADD COLUMN r2_complete INTEGER NOT NULL DEFAULT 0",
            );
          }
          if (!tombstones?.includes("edge_purge_complete")) {
            ctx.storage.sql.exec(
              "ALTER TABLE pending_r2_tombstones ADD COLUMN edge_purge_complete INTEGER NOT NULL DEFAULT 0",
            );
          }
          ctx.storage.sql.exec("INSERT INTO metadata_schema_migrations (version) VALUES (4)");
        }
        if (!migrations.has(5)) {
          const metadataState = schemas.find(({ name }) => name === "metadata_state")?.sql;
          const tombstones = schemas.find(({ name }) => name === "pending_r2_tombstones")?.sql;
          if (!metadataState?.includes("tombstone_sequence")) {
            ctx.storage.sql.exec(
              "ALTER TABLE metadata_state ADD COLUMN tombstone_sequence INTEGER NOT NULL DEFAULT 0",
            );
          }
          if (!tombstones?.includes("tombstone_sequence")) {
            ctx.storage.sql.exec(
              "ALTER TABLE pending_r2_tombstones ADD COLUMN tombstone_sequence INTEGER NOT NULL DEFAULT 0",
            );
          }
          ctx.storage.sql.exec("INSERT INTO metadata_schema_migrations (version) VALUES (5)");
        }
        if (!migrations.has(6)) {
          ctx.storage.sql.exec("DELETE FROM entry_tags");
          const entries = ctx.storage.sql.exec<{ key_hash: string; cache_tags: string }>(
            "SELECT key_hash, cache_tags FROM entries WHERE cache_tags IS NOT NULL",
          );
          for (const entry of entries) {
            this.replaceEntryTags(entry.key_hash, JSON.parse(entry.cache_tags) as string[]);
          }
          ctx.storage.sql.exec("INSERT INTO metadata_schema_migrations (version) VALUES (6)");
        }
      });
      ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS pending_r2_tombstones_r2_pending
          ON pending_r2_tombstones(key_hash) WHERE r2_complete = 0;
        CREATE INDEX IF NOT EXISTS pending_r2_tombstones_edge_pending
          ON pending_r2_tombstones(key_hash)
          WHERE r2_complete = 1 AND edge_purge_complete = 0;
      `);
    });
  }

  private async ensureCleanupAlarm(createdAt: number): Promise<void> {
    if (this.cleanupAlarmKnown) return;
    await this.scheduleCleanupAlarm(createdAt + ORPHAN_RETENTION_MS);
  }

  private async scheduleCleanupAlarm(scheduledTime: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > scheduledTime) {
      await this.ctx.storage.setAlarm(scheduledTime);
    }
    this.cleanupAlarmKnown = true;
  }

  private logCleanupFailure(error: unknown): void {
    console.error(
      JSON.stringify({
        message: "Workers Response Store cleanup scheduling failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private tombstoneSequence(increment = false): number {
    const statement = increment
      ? `UPDATE metadata_state SET tombstone_sequence = tombstone_sequence + 1
        WHERE singleton = 1 RETURNING tombstone_sequence`
      : "SELECT tombstone_sequence FROM metadata_state WHERE singleton = 1";
    return this.ctx.storage.sql.exec<{ tombstone_sequence: number }>(statement).one()
      .tombstone_sequence;
  }

  private getR2TombstoneEdgePurger(): R2TombstoneEdgePurger {
    const factory = Reflect.get(this.ctx.exports, "ResponseStoreBinding") as
      | (R2TombstoneEdgePurger &
          ((options: { props: Record<string, never> }) => R2TombstoneEdgePurger))
      | undefined;
    if (typeof factory !== "function") {
      throw new Error("The ResponseStoreBinding entrypoint is not exported");
    }
    return factory({ props: {} });
  }

  private findMatchingEntryRows(options: ResponseStorePurgeOptions): EntryRow[];
  private findMatchingEntryRows(
    options: ResponseStorePurgeOptions,
    includePending: true,
  ): PurgeEntryRow[];
  private findMatchingEntryRows(
    options: ResponseStorePurgeOptions,
    includePending = false,
  ): EntryRow[] | PurgeEntryRow[] {
    const selectors: string[] = [];
    const parameters: string[] = [];
    if (!options.purgeEverything) {
      const tags = normalizeTags(options.tags ?? []);
      if (tags.length) {
        selectors.push(`entries.key_hash IN (
          SELECT key_hash FROM entry_tags
          WHERE tag IN (SELECT value FROM json_each(?))
        )`);
        parameters.push(JSON.stringify(tags));
      }
      if (options.pathPrefixes?.length) {
        selectors.push(`EXISTS (
          SELECT 1 FROM json_each(?) AS path_prefix
          WHERE instr(entries.cache_key, path_prefix.value) = 1
        )`);
        parameters.push(JSON.stringify(options.pathPrefixes));
      }
    }
    if (!options.purgeEverything && !selectors.length) return [];

    const conditions: string[] = [];
    if (!includePending) {
      conditions.push("tombstoned = 0 AND active_revision IS NOT NULL");
    }
    if (!options.purgeEverything) {
      conditions.push(`(${selectors.join(" OR ")})`);
    }

    return this.ctx.storage.sql
      .exec<EntryRow>(
        `SELECT ${
          includePending ? "key_hash, cache_key, latest_revision, object_key" : "*"
        } FROM entries ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
        ...parameters,
      )
      .toArray();
  }

  private replaceEntryTags(keyHash: string, tags: string[]): void {
    this.ctx.storage.sql.exec("DELETE FROM entry_tags WHERE key_hash = ?", keyHash);
    for (const batch of batches(normalizeTags(tags), MAX_SQL_PARAMETERS / 2)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO entry_tags (tag, key_hash) VALUES ${batch.map(() => "(?, ?)").join(", ")}`,
        ...batch.flatMap((tag) => [tag, keyHash]),
      );
    }
  }

  async trackPendingObjects(objectKeys: string[], createdAt: number): Promise<void> {
    if (!objectKeys.length) {
      return;
    }

    this.ctx.storage.transactionSync(() => {
      for (const batch of batches(objectKeys, MAX_SQL_PARAMETERS / 2)) {
        const values = batch.flatMap((objectKey) => [objectKey, createdAt]);
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO pending_objects
            (object_key, created_at, publishable) VALUES ${batch
              .map(() => "(?, ?, 0)")
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
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM pending_objects WHERE object_key = ?", objectKey);
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
      .exec<{
        active: number;
        created_at: number;
        object_key: string;
      }>(
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
    const expired = batch.filter(({ active, created_at }) => !active && created_at <= cutoff);
    const expiredObjectKeys = expired.map(({ object_key }) => object_key);
    this.finishPendingObjects([...activeObjectKeys, ...expiredObjectKeys]);

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
      if (await this.retryPendingTombstones()) {
        await this.ctx.storage.setAlarm(Date.now());
        this.cleanupAlarmKnown = true;
        return;
      }
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

  async retryPendingTombstones(): Promise<boolean> {
    const drained = await this.drainPendingTombstones(400);
    if (drained.failures.length) {
      throw new AggregateError(
        drained.failures.map((failure) => new Error(failure)),
        "R2 tombstone cleanup failed",
      );
    }
    const edgeEntries = this.listPendingEdgePurges(400);
    if (edgeEntries.length) {
      if (!(await this.getR2TombstoneEdgePurger().purgeR2TombstoneEdges(edgeEntries))) {
        throw new Error("Workers Response Store cache purge is unavailable");
      }
      this.markTombstonesEdgePurged(edgeEntries);
    }
    return (
      this.ctx.storage.sql
        .exec<{ pending: number }>("SELECT EXISTS(SELECT 1 FROM pending_r2_tombstones) AS pending")
        .one().pending === 1
    );
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
        .exec<EntryRow>(
          `SELECT entries.*,
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

      const storedEntry = storedEntryFromRow(entry);
      if (!storedEntry?.revalidator) return null;

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
        `INSERT OR REPLACE INTO pending_objects
          (object_key, created_at, invalidation_sequence)
        VALUES (?, ?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))`,
        objectKey,
        now,
      );

      return { claimId, entry: storedEntry, objectKey, revision };
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

  async reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<WriteReservation> {
    const reservation = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<{ active_revision: number | null; latest_revision: number }>(
          "SELECT active_revision, latest_revision FROM entries WHERE key_hash = ?",
          keyHash,
        )
        .toArray()[0];

      const revision = this.reserveRevision(keyHash, cacheKey, current);
      const objectKey = `${objectKeyPrefix}/${revision}`;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO pending_objects
          (object_key, created_at, invalidation_sequence)
        VALUES (?, ?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))`,
        objectKey,
        createdAt,
      );
      return { objectKey, r2ObjectAbsent: current === undefined, revision };
    });
    await this.ensureCleanupAlarm(createdAt);
    return reservation;
  }

  async replaceFailedWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    failedObjectKey: string,
    fenceTags: string[],
    createdAt: number,
  ): Promise<WriteReservation | null> {
    const reservation = this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql
        .exec<{ invalidation_sequence: number; publishable: number }>(
          "SELECT invalidation_sequence, publishable FROM pending_objects WHERE object_key = ?",
          failedObjectKey,
        )
        .toArray()[0];
      const currentInvalidationSequence = this.ctx.storage.sql
        .exec<{ tag_invalidation_sequence: number }>(
          "SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1",
        )
        .one().tag_invalidation_sequence;
      const keyInvalidationSequence = this.ctx.storage.sql
        .exec<{ invalidation_sequence: number }>(
          "SELECT invalidation_sequence FROM key_invalidations WHERE key_hash = ?",
          keyHash,
        )
        .toArray()[0]?.invalidation_sequence;
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_objects WHERE object_key = ?",
        failedObjectKey,
      );
      if (
        !pending ||
        pending.publishable !== 1 ||
        (keyInvalidationSequence ?? 0) > pending.invalidation_sequence ||
        (currentInvalidationSequence > pending.invalidation_sequence &&
          this.getTagInvalidationMaximum(fenceTags, "invalidation_sequence") >
            pending.invalidation_sequence)
      ) {
        return null;
      }

      const current = this.ctx.storage.sql
        .exec<{ active_revision: number | null; latest_revision: number }>(
          "SELECT active_revision, latest_revision FROM entries WHERE key_hash = ?",
          keyHash,
        )
        .toArray()[0];
      const revision = this.reserveRevision(keyHash, cacheKey, current);
      const objectKey = `${objectKeyPrefix}/${revision}`;
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_objects
          (object_key, created_at, invalidation_sequence) VALUES (?, ?, ?)`,
        objectKey,
        createdAt,
        currentInvalidationSequence,
      );
      return { objectKey, r2ObjectAbsent: false, revision };
    });
    if (reservation) await this.ensureCleanupAlarm(createdAt);
    return reservation;
  }

  async reserveRegeneration(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<RegenerationReservation | null> {
    const result = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<EntryRow>(
          "SELECT * FROM entries WHERE key_hash = ? AND cache_key = ?",
          keyHash,
          cacheKey,
        )
        .toArray()[0];
      const entry = current ? storedEntryFromRow(current) : null;
      if (!entry) return null;
      if (!entry.revalidator) return { entry };

      const revision = this.reserveRevision(keyHash, cacheKey, current);
      const objectKey = `${objectKeyPrefix}/${revision}`;
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO pending_objects
          (object_key, created_at, invalidation_sequence)
        VALUES (?, ?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))`,
        objectKey,
        createdAt,
      );
      return {
        entry,
        reservation: { objectKey, r2ObjectAbsent: false, revision },
      };
    });
    if (result?.reservation) await this.ensureCleanupAlarm(createdAt);
    return result;
  }

  async publish(
    keyHash: string,
    revision: number,
    metadata: CandidateMetadata,
    claimId?: string,
    reservationObjectKey = metadata.objectKey,
  ): Promise<PublicationResult> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<EntryRow>(
          `SELECT entries.*,
            revalidation_claims.active_revision AS claim_active_revision,
            revalidation_claims.claim_id AS claim_id,
            revalidation_claims.revision AS claim_revision,
            pending_objects.invalidation_sequence AS pending_invalidation_sequence,
            pending_objects.publishable AS pending_publishable,
            metadata_state.tag_invalidation_sequence AS current_invalidation_sequence
          FROM entries
          CROSS JOIN metadata_state
          LEFT JOIN pending_objects ON pending_objects.object_key = ?
          LEFT JOIN revalidation_claims ON revalidation_claims.key_hash = entries.key_hash
          WHERE entries.key_hash = ?`,
          reservationObjectKey,
          keyHash,
        )
        .toArray()[0];
      if (
        !current ||
        current.pending_invalidation_sequence === null ||
        current.pending_invalidation_sequence === undefined ||
        current.pending_publishable !== 1 ||
        revision > current.latest_revision ||
        (current.active_revision !== null && revision <= current.active_revision) ||
        (claimId !== undefined &&
          (current.claim_id !== claimId ||
            current.claim_revision !== revision ||
            current.claim_active_revision !== current.active_revision)) ||
        (metadata.fenceTags.length > 0 &&
          current.current_invalidation_sequence! > current.pending_invalidation_sequence &&
          this.getTagInvalidationMaximum(metadata.fenceTags, "invalidation_sequence") >
            current.pending_invalidation_sequence)
      ) {
        if (claimId) {
          this.ctx.storage.sql.exec(
            "DELETE FROM revalidation_claims WHERE key_hash = ? AND claim_id = ?",
            keyHash,
            claimId,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM pending_objects WHERE object_key = ?",
          reservationObjectKey,
        );
        return {
          edgePurgeRequired: false,
          entry: current ? storedEntryFromRow(current) : null,
          published: false,
        };
      }

      const update = this.ctx.storage.sql.exec<{ key_hash: string }>(
        `UPDATE entries SET
          active_revision = ?, object_key = ?, status_text = ?, response_headers = ?,
          fresh_until = ?, swr_until = ?,
          revalidator_id = ?, revalidator_args = ?, cache_tags = ?, tombstoned = 0
        WHERE key_hash = ? AND latest_revision >= ?
          AND (active_revision IS NULL OR active_revision < ?)
        RETURNING key_hash`,
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
        revision,
      );

      const published = update.toArray().length === 1;
      if (published) {
        this.replaceEntryTags(keyHash, metadata.cacheTags);
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM pending_objects WHERE object_key = ?",
        reservationObjectKey,
      );
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
        latestRevision: current.latest_revision,
        objectKey: metadata.objectKey,
        statusText: metadata.statusText,
        responseHeaders: metadata.responseHeaders,
        freshUntil: metadata.freshUntil,
        swrUntil: metadata.swrUntil,
        revalidator: metadata.revalidator,
        cacheTags: metadata.cacheTags,
      };

      return {
        edgePurgeRequired: published && current.active_revision !== null,
        entry: published ? entry : null,
        published,
      };
    });
  }

  async invalidatePublishedRevision(
    keyHash: string,
    revision: number,
  ): Promise<TombstoneDrainResult> {
    const queued = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<EntryRow>("SELECT * FROM entries WHERE key_hash = ?", keyHash)
        .toArray()[0];
      if (!current || current.active_revision !== revision || current.object_key === null) {
        return false;
      }

      const tombstoneRevision = current.latest_revision + 1;
      const tombstoneSequence = this.tombstoneSequence(true);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO pending_r2_tombstones
          (key_hash, cache_key, object_key, revision, tombstone_sequence)
          VALUES (?, ?, ?, ?, ?)`,
        keyHash,
        current.cache_key,
        current.object_key,
        tombstoneRevision,
        tombstoneSequence,
      );
      this.ctx.storage.sql.exec(
        `UPDATE entries SET
          latest_revision = ?, active_revision = ?, object_key = NULL,
          status_text = NULL, response_headers = NULL, fresh_until = NULL,
          swr_until = NULL, revalidator_id = NULL, revalidator_args = NULL,
          cache_tags = NULL, tombstoned = 1
        WHERE key_hash = ? AND active_revision = ?`,
        tombstoneRevision,
        tombstoneRevision,
        keyHash,
        revision,
      );
      this.ctx.storage.sql.exec("DELETE FROM revalidation_claims WHERE key_hash = ?", keyHash);
      this.ctx.storage.sql.exec("DELETE FROM entry_tags WHERE key_hash = ?", keyHash);
      return true;
    });

    if (!queued) return { failures: [], pending: [], purged: [] };
    await this.scheduleCleanupAlarm(Date.now() + ORPHAN_CLEANUP_RETRY_MS).catch((error) =>
      this.logCleanupFailure(error),
    );
    return this.drainPendingTombstones(1, keyHash);
  }

  getEntry(keyHash: string): StoredEntry | null {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE key_hash = ?", keyHash)
      .toArray()[0];
    return row ? storedEntryFromRow(row) : null;
  }

  private getTagInvalidationMaximum(
    tags: string[],
    column: "invalidated_at" | "invalidation_sequence",
  ): number {
    const normalized = normalizeTags(tags);
    let expiration = 0;

    for (const batch of batches(normalized, MAX_SQL_PARAMETERS)) {
      const placeholders = batch.map(() => "?").join(", ");
      const row = this.ctx.storage.sql
        .exec<{ invalidated_at: number | null }>(
          `SELECT MAX(${column}) AS invalidated_at
          FROM tag_invalidations WHERE tag IN (${placeholders})`,
          ...batch,
        )
        .one();
      expiration = Math.max(expiration, row.invalidated_at ?? 0);
    }

    return expiration;
  }

  getTagExpiration(tags: string[]): number {
    return this.getTagInvalidationMaximum(tags, "invalidated_at");
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
          `INSERT OR REPLACE INTO pending_objects
            (object_key, created_at, invalidation_sequence) VALUES ${batch
              .map(
                () =>
                  "(?, ?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))",
              )
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

  async purgeMatching(
    options: ResponseStorePurgeOptions,
    invalidatedAt = Date.now(),
  ): Promise<PurgeReservation> {
    const reservation = this.ctx.storage.transactionSync(() => {
      const matches = this.findMatchingEntryRows(options, true);
      const tombstoneSequence = this.tombstoneSequence(
        matches.some((row) => row.object_key !== null),
      );

      const tags = normalizeTags(options.tags ?? []);
      this.ctx.storage.sql.exec(
        `UPDATE metadata_state SET tag_invalidation_sequence = tag_invalidation_sequence + 1
        WHERE singleton = 1`,
      );
      for (const batch of batches(matches, MAX_SQL_PARAMETERS)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO key_invalidations (key_hash, invalidation_sequence) VALUES ${batch
            .map(
              () =>
                "(?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))",
            )
            .join(", ")}
          ON CONFLICT(key_hash) DO UPDATE SET invalidation_sequence =
            MAX(key_invalidations.invalidation_sequence, excluded.invalidation_sequence)`,
          ...batch.map((row) => row.key_hash),
        );
      }
      for (const batch of batches(tags, MAX_SQL_PARAMETERS / 2)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO tag_invalidations
            (tag, invalidated_at, invalidation_sequence) VALUES ${batch
              .map(
                () =>
                  "(?, ?, (SELECT tag_invalidation_sequence FROM metadata_state WHERE singleton = 1))",
              )
              .join(", ")}
          ON CONFLICT(tag) DO UPDATE SET invalidated_at =
            MAX(tag_invalidations.invalidated_at, excluded.invalidated_at),
            invalidation_sequence = MAX(
              tag_invalidations.invalidation_sequence,
              excluded.invalidation_sequence
            )`,
          ...batch.flatMap((tag) => [tag, invalidatedAt]),
        );
      }

      for (const batch of batches(matches, MAX_SQL_PARAMETERS - 1)) {
        const active = batch.filter((row) => row.object_key !== null);
        for (const entryBatch of batches(active, MAX_SQL_PARAMETERS / 5)) {
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO pending_r2_tombstones
              (key_hash, cache_key, object_key, revision, tombstone_sequence) VALUES ${entryBatch
                .map(() => "(?, ?, ?, ?, ?)")
                .join(", ")}`,
            ...entryBatch.flatMap((row) => [
              row.key_hash,
              row.cache_key,
              row.object_key!,
              row.latest_revision + 1,
              tombstoneSequence,
            ]),
          );
        }
        const keyHashes = batch.map((row) => row.key_hash);
        const placeholders = keyHashes.map(() => "?").join(", ");
        this.ctx.storage.sql.exec(
          `UPDATE entries SET
            latest_revision = latest_revision + 1,
            active_revision = latest_revision + 1,
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
        this.ctx.storage.sql.exec(
          `DELETE FROM entry_tags WHERE key_hash IN (${placeholders})`,
          ...keyHashes,
        );
      }

      return {
        backingStoreUpdated: matches.length > 0 || tags.length > 0,
        pendingTombstones: matches.filter((row) => row.object_key !== null).length,
        tombstoneSequence,
      };
    });
    if (reservation.pendingTombstones > 0) {
      await this.scheduleCleanupAlarm(Date.now() + ORPHAN_CLEANUP_RETRY_MS).catch((error) =>
        this.logCleanupFailure(error),
      );
    }
    return reservation;
  }

  private async writeR2Tombstone(entry: PurgedEntry): Promise<void> {
    let etag: string | null | undefined;
    for (let attempt = 0; attempt < MAX_R2_CAS_ATTEMPTS; attempt++) {
      const current = await this.env.CACHE_BODIES.head(entry.objectKey);
      const currentRevision = metadataInteger(current?.customMetadata?.latestRevision);
      if (currentRevision !== undefined && currentRevision >= entry.revision) return;
      etag = current?.etag ?? null;

      const stored = await this.env.CACHE_BODIES.put(entry.objectKey, new Uint8Array(), {
        onlyIf: etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: etag },
        customMetadata: {
          latestRevision: String(entry.revision),
          tombstoned: "1",
        },
      });
      if (stored) return;
    }
    const current = await this.env.CACHE_BODIES.head(entry.objectKey);
    const currentRevision = metadataInteger(current?.customMetadata?.latestRevision);
    if (currentRevision !== undefined && currentRevision >= entry.revision) return;
    throw new Error(
      `R2 revision ${entry.revision} could not be tombstoned after concurrent writes`,
    );
  }

  private finishCompletedTombstones(entries: PurgedEntry[]): void {
    for (const batch of batches(entries, MAX_SQL_PARAMETERS / 2)) {
      this.ctx.storage.sql.exec(
        `DELETE FROM pending_r2_tombstones
        WHERE r2_complete = 1 AND edge_purge_complete = 1 AND (${batch
          .map(() => "(key_hash = ? AND revision = ?)")
          .join(" OR ")})`,
        ...batch.flatMap((entry) => [entry.keyHash, entry.revision]),
      );
    }
  }

  async drainPendingTombstones(
    limit: number,
    keyHash?: string,
    afterKeyHash?: string,
    tombstoneSequence?: number,
  ): Promise<TombstoneDrainResult> {
    const filters = ["r2_complete = 0"];
    const parameters: (number | string)[] = [];
    if (keyHash !== undefined) {
      filters.push("key_hash = ?");
      parameters.push(keyHash);
    }
    if (afterKeyHash !== undefined) {
      filters.push("key_hash > ?");
      parameters.push(afterKeyHash);
    }
    if (tombstoneSequence !== undefined) {
      filters.push("tombstone_sequence = ?");
      parameters.push(tombstoneSequence);
    }
    parameters.push(limit);
    const rows = this.ctx.storage.sql
      .exec<PendingTombstoneRow>(
        `SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
        FROM pending_r2_tombstones
        WHERE ${filters.join(" AND ")}
        ORDER BY key_hash LIMIT ?`,
        ...parameters,
      )
      .toArray();
    const pending = rows.map((row) => ({
      keyHash: row.key_hash,
      cacheKey: row.cache_key,
      objectKey: row.object_key,
      revision: row.revision,
    }));
    const settled = await mapSettledWithR2Concurrency(
      pending,
      async (entry): Promise<PurgedEntry> => {
        await this.writeR2Tombstone(entry);
        return entry;
      },
    );
    const purged = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    this.ctx.storage.transactionSync(() => {
      for (const batch of batches(purged, MAX_SQL_PARAMETERS / 2)) {
        this.ctx.storage.sql.exec(
          `UPDATE pending_r2_tombstones SET r2_complete = 1 WHERE ${batch
            .map(() => "(key_hash = ? AND revision = ?)")
            .join(" OR ")}`,
          ...batch.flatMap((entry) => [entry.keyHash, entry.revision]),
        );
      }
      this.finishCompletedTombstones(purged);
    });
    return {
      ...(rows.length ? { cursor: rows.at(-1)!.key_hash } : {}),
      failures: settled.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      ),
      pending,
      purged,
    };
  }

  listPendingEdgePurges(limit: number, tombstoneSequence?: number): PurgedEntry[] {
    const sequenceFilter = tombstoneSequence === undefined ? "" : " AND tombstone_sequence = ?";
    return this.ctx.storage.sql
      .exec<PendingTombstoneRow>(
        `SELECT key_hash, cache_key, object_key, revision, r2_complete, edge_purge_complete
        FROM pending_r2_tombstones
        WHERE r2_complete = 1 AND edge_purge_complete = 0${sequenceFilter}
        ORDER BY key_hash LIMIT ?`,
        ...(tombstoneSequence === undefined ? [] : [tombstoneSequence]),
        limit,
      )
      .toArray()
      .map((row) => ({
        keyHash: row.key_hash,
        cacheKey: row.cache_key,
        objectKey: row.object_key,
        revision: row.revision,
      }));
  }

  markTombstonesEdgePurged(entries: PurgedEntry[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const batch of batches(entries, MAX_SQL_PARAMETERS / 2)) {
        this.ctx.storage.sql.exec(
          `UPDATE pending_r2_tombstones SET edge_purge_complete = 1 WHERE ${batch
            .map(() => "(key_hash = ? AND revision = ?)")
            .join(" OR ")}`,
          ...batch.flatMap((entry) => [entry.keyHash, entry.revision]),
        );
      }
      this.finishCompletedTombstones(entries);
    });
  }

  markTombstonesEdgePurgedThrough(tombstoneSequence: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM pending_r2_tombstones
      WHERE r2_complete = 1 AND edge_purge_complete = 0 AND tombstone_sequence <= ?`,
      tombstoneSequence,
    );
  }

  inspect(): StoredEntry[] {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY cache_key")
      .toArray();
    return storedEntriesFromRows(rows);
  }
}
