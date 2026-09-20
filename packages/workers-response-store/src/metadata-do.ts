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
  entry: StoredEntry;
  objectKey: string;
  revision: number;
};

type PublicationResult = {
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

export type CacheMetadataStub = DurableObjectStub & {
  reserveWrite(
    keyHash: string,
    cacheKey: string,
    objectKeyPrefix: string,
    createdAt: number,
  ): Promise<WriteReservation>;
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
  getEntry(keyHash: string): Promise<StoredEntry | null>;
  getTagExpiration(tags: string[]): Promise<number>;
  reserveRefresh(
    options: ResponseStoreRefreshOptions,
    objectKeyRoot: string,
    createdAt: number,
  ): Promise<RefreshCandidate[]>;
  purgeMatching(options: ResponseStorePurgeOptions, invalidatedAt?: number): Promise<PurgedEntry[]>;
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

const MAX_SQL_PARAMETERS = 100;
const ORPHAN_RETENTION_MS = 60 * 60 * 1000;
const ORPHAN_CLEANUP_LIMIT = 100;
const ORPHAN_CLEANUP_RETRY_MS = 60 * 1000;

type CacheMetadataEnv = Record<string, unknown>;

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
          tag_invalidation_sequence INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO metadata_state (singleton, tag_invalidation_sequence) VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS pending_objects (
          object_key TEXT PRIMARY KEY,
          invalidation_sequence INTEGER NOT NULL DEFAULT 0,
          publishable INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_objects_created_at ON pending_objects(created_at);
      `);

      ctx.storage.transactionSync(() => {
        const migrations = new Set(
          ctx.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM metadata_schema_migrations WHERE version IN (2, 3)",
            )
            .toArray()
            .map(({ version }) => version),
        );
        if (migrations.size === 2) return;

        const schemas = ctx.storage.sql
          .exec<{ name: string; sql: string }>(
            `SELECT name, sql FROM sqlite_schema
            WHERE type = 'table' AND name IN ('tag_invalidations', 'pending_objects')`,
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
      });
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

  private findMatchingEntryRows(
    options: ResponseStorePurgeOptions,
    includePending = false,
  ): EntryRow[] {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(
        includePending
          ? `SELECT * FROM entries
            WHERE (tombstoned = 0 AND active_revision IS NOT NULL)
              OR active_revision IS NULL OR latest_revision > active_revision`
          : "SELECT * FROM entries WHERE tombstoned = 0 AND active_revision IS NOT NULL",
      )
      .toArray();
    if (options.purgeEverything) {
      return rows;
    }

    const tags = new Set(normalizeTags(options.tags ?? []));
    const prefixes = options.pathPrefixes ?? [];
    return rows.filter(
      (row) =>
        prefixes.some((prefix) => row.cache_key.startsWith(prefix)) ||
        normalizeTags(JSON.parse(row.cache_tags ?? "[]") as string[]).some((tag) => tags.has(tag)),
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
        return { entry: current ? storedEntryFromRow(current) : null, published: false };
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
        entry: published ? entry : null,
        published,
      };
    });
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
  ): Promise<PurgedEntry[]> {
    const matches = this.ctx.storage.transactionSync(() => {
      const matches = this.findMatchingEntryRows(options, true);

      const tags = normalizeTags(options.tags ?? []);
      if (tags.length) {
        this.ctx.storage.sql.exec(
          `UPDATE metadata_state SET tag_invalidation_sequence = tag_invalidation_sequence + 1
          WHERE singleton = 1`,
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
      }

      return matches.flatMap((row) =>
        row.object_key === null
          ? []
          : [
              {
                keyHash: row.key_hash,
                cacheKey: row.cache_key,
                objectKey: row.object_key,
                revision: row.latest_revision + 1,
              },
            ],
      );
    });
    return matches;
  }

  inspect(): StoredEntry[] {
    const rows = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY cache_key")
      .toArray();
    return storedEntriesFromRows(rows);
  }
}
