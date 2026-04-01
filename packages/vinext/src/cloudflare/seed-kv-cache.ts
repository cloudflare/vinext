/**
 * Seed Workers KV cache from pre-rendered build output at deploy time.
 *
 * Reads `vinext-prerender.json` and the corresponding HTML/RSC files from
 * `dist/server/prerendered-routes/`, constructs cache entries in the exact
 * format that `KVCacheHandler.get()` expects at runtime, then uploads them
 * to KV via the Cloudflare bulk REST API.
 *
 * This runs as a deploy-time step in Node.js — never inside a Worker.
 * Deploy-time deps (fs, fetch to Cloudflare API) are not bundled into the
 * worker output because this module is only imported by `deploy.ts`.
 *
 * Cache key format (must match `KVCacheHandler.get()` at runtime):
 *   KV key = ENTRY_PREFIX + isrCacheKey(router, pathname, buildId) + suffix
 *   e.g. "cache:app:abc123:/blog/hello:html"
 *
 * Cache value format (must match `KVCacheEntry` in kv-cache-handler.ts):
 *   { value: SerializedIncrementalCacheValue, tags: string[], lastModified, revalidateAt }
 *   ArrayBuffers (rscData) are base64-encoded for JSON storage.
 *
 * Limitations:
 * - Only App Router routes are seeded (Pages Router not yet supported).
 * - Tags are not populated (they are computed at render time, not statically
 *   known). This means `revalidatePath()` calls will not invalidate seeded
 *   entries until they are overwritten by a live request through the ISR path.
 */

import fs from "node:fs";
import path from "node:path";
import { isrCacheKey } from "../server/isr-cache.js";
import { getOutputPath, getRscOutputPath } from "../build/prerender.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Must match ENTRY_PREFIX in kv-cache-handler.ts */
const ENTRY_PREFIX = "cache:";

/** KV bulk API accepts up to 10,000 pairs per request */
const BATCH_SIZE = 10_000;

/** Minimum KV expiration TTL (Cloudflare minimum is 60 seconds) */
const MIN_KV_TTL_SECONDS = 60;

/** Default KV expiration TTL: 30 days */
const DEFAULT_KV_TTL_SECONDS = 30 * 24 * 3600;

/** Max characters of API error body to include in error messages */
const MAX_ERROR_BODY_LENGTH = 500;

// ─── Types ──────────────────────────────────────────────────────────────────

type PrerenderManifest = {
  buildId: string;
  trailingSlash?: boolean;
  routes: PrerenderManifestRoute[];
};

type PrerenderManifestRoute = {
  route: string;
  status: string;
  revalidate?: number | false;
  path?: string;
  router?: "app" | "pages";
};

export type SeedKVOptions = {
  /** Project root directory (where dist/ lives) */
  root: string;
  /** Cloudflare account ID */
  accountId: string;
  /** KV namespace ID for VINEXT_CACHE */
  namespaceId: string;
  /** Cloudflare API token with KV write permissions */
  apiToken: string;
};

export type SeedKVResult = {
  /** Number of routes seeded (each route = up to 2 KV entries: html + rsc) */
  seededRoutes: number;
  /** Number of KV pairs uploaded */
  kvPairsUploaded: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** If set, seeding was skipped with this reason */
  skipped?: string;
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read pre-rendered routes from disk and upload them to Workers KV.
 *
 * This is the deploy-time equivalent of `seedMemoryCacheFromPrerender()` —
 * instead of populating an in-memory CacheHandler, it writes directly to KV
 * via the Cloudflare REST API so the entries are available the moment the
 * Worker goes live.
 */
export async function seedKVCacheFromPrerender(options: SeedKVOptions): Promise<SeedKVResult> {
  const startTime = Date.now();
  const { root, accountId, namespaceId, apiToken } = options;

  const skip = (reason: string): SeedKVResult => ({
    seededRoutes: 0,
    kvPairsUploaded: 0,
    durationMs: Date.now() - startTime,
    skipped: reason,
  });

  // ── 1. Read the prerender manifest ──────────────────────────────────────
  const serverDir = path.join(root, "dist", "server");
  const manifestPath = path.join(serverDir, "vinext-prerender.json");

  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    return skip("no vinext-prerender.json found");
  }

  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return skip("failed to parse vinext-prerender.json");
  }

  const { buildId, routes } = manifest;
  if (!buildId || !Array.isArray(routes)) {
    return skip("manifest missing buildId or routes");
  }

  const trailingSlash = manifest.trailingSlash ?? false;
  const prerenderDir = path.resolve(serverDir, "prerendered-routes");

  // ── 2. Build KV pairs from pre-rendered files ───────────────────────────
  const pairs: Array<{ key: string; value: string; expiration_ttl?: number }> = [];
  let seededRoutes = 0;

  for (const route of routes) {
    if (route.status !== "rendered") continue;
    if (route.router !== "app") continue;

    const pathname = route.path ?? route.route;
    const baseKey = isrCacheKey("app", pathname, buildId);

    const revalidateSeconds = typeof route.revalidate === "number" ? route.revalidate : undefined;

    const now = Date.now();
    const revalidateAt =
      revalidateSeconds !== undefined && revalidateSeconds > 0
        ? now + revalidateSeconds * 1000
        : null;

    // KV TTL: match runtime KVCacheHandler.set() logic —
    // ISR routes get 10x revalidate clamped to [60s, 30d].
    // Static routes (revalidateAt === null) get no expiry, matching runtime behavior.
    const kvTtl: number | undefined =
      revalidateSeconds !== undefined && revalidateSeconds > 0
        ? Math.max(Math.min(revalidateSeconds * 10, DEFAULT_KV_TTL_SECONDS), MIN_KV_TTL_SECONDS)
        : undefined;

    // ── HTML entry ──────────────────────────────────────────────────────
    const htmlRelPath = getOutputPath(pathname, trailingSlash);
    const htmlFullPath = path.resolve(prerenderDir, htmlRelPath);

    // Path traversal guard: ensure resolved path stays within prerenderDir
    if (!htmlFullPath.startsWith(prerenderDir + path.sep) && htmlFullPath !== prerenderDir) {
      continue;
    }

    let html: string;
    try {
      html = fs.readFileSync(htmlFullPath, "utf-8");
    } catch {
      continue; // File missing or unreadable — skip this route
    }

    const htmlEntry = {
      value: {
        kind: "APP_PAGE" as const,
        html,
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        status: undefined,
      },
      tags: [] as string[],
      lastModified: now,
      revalidateAt,
    };

    const htmlPair: { key: string; value: string; expiration_ttl?: number } = {
      key: ENTRY_PREFIX + baseKey + ":html",
      value: JSON.stringify(htmlEntry),
    };
    if (kvTtl !== undefined) htmlPair.expiration_ttl = kvTtl;
    pairs.push(htmlPair);

    // ── RSC entry ───────────────────────────────────────────────────────
    const rscRelPath = getRscOutputPath(pathname);
    const rscFullPath = path.resolve(prerenderDir, rscRelPath);

    // Path traversal guard
    if (rscFullPath.startsWith(prerenderDir + path.sep) || rscFullPath === prerenderDir) {
      try {
        const rscBuffer = fs.readFileSync(rscFullPath);
        const rscBase64 = rscBuffer.toString("base64");

        const rscEntry = {
          value: {
            kind: "APP_PAGE" as const,
            html: "",
            rscData: rscBase64,
            headers: undefined,
            postponed: undefined,
            status: undefined,
          },
          tags: [] as string[],
          lastModified: now,
          revalidateAt,
        };

        const rscPair: { key: string; value: string; expiration_ttl?: number } = {
          key: ENTRY_PREFIX + baseKey + ":rsc",
          value: JSON.stringify(rscEntry),
        };
        if (kvTtl !== undefined) rscPair.expiration_ttl = kvTtl;
        pairs.push(rscPair);
      } catch {
        // RSC file missing or unreadable — seed HTML-only
      }
    }

    seededRoutes++;
  }

  if (pairs.length === 0) {
    return skip("no pre-rendered App Router routes found");
  }

  // ── 3. Upload to KV in batches ──────────────────────────────────────────
  await uploadBulkToKV(pairs, namespaceId, accountId, apiToken);

  return {
    seededRoutes,
    kvPairsUploaded: pairs.length,
    durationMs: Date.now() - startTime,
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Upload key-value pairs to KV via the Cloudflare bulk REST API.
 * Splits into batches of BATCH_SIZE to respect the 10,000-pair limit.
 */
export async function uploadBulkToKV(
  pairs: Array<{ key: string; value: string; expiration_ttl?: number }>,
  namespaceId: string,
  accountId: string,
  apiToken: string,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pairs.length / BATCH_SIZE);

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `KV bulk upload failed (batch ${batchNum}/${totalBatches}): HTTP ${response.status} — ${text.slice(0, MAX_ERROR_BODY_LENGTH)}`,
      );
    }

    // Cloudflare can return 200 with success:false for semantic errors
    const body = (await response.json()) as {
      success?: boolean;
      errors?: Array<{ message: string }>;
    };
    if (body.success === false) {
      const errMsg = body.errors?.map((e) => e.message).join("; ") ?? "unknown error";
      throw new Error(
        `KV bulk upload rejected (batch ${batchNum}/${totalBatches}): ${errMsg.slice(0, MAX_ERROR_BODY_LENGTH)}`,
      );
    }
  }
}
