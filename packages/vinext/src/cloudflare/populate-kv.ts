/**
 * Deploy-time KV population for Cloudflare Workers.
 *
 * Uploads pre-rendered HTML and RSC data to Workers KV during deployment
 * so first requests are served from cache instead of rendered on the fly.
 *
 * Key construction and tag generation match the runtime functions in
 * entries/app-rsc-entry.ts exactly — see appPageCacheKey and buildPageTags.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fnv1a64 } from "../utils/hash.js";
import { getOutputPath, getRscOutputPath } from "../build/prerender.js";

/** Key prefix for cache entries. Matches kv-cache-handler.ts ENTRY_PREFIX. */
export const ENTRY_PREFIX = "cache:";

/** Default KV TTL in seconds (30 days). Matches KVCacheHandler default. */
export const KV_TTL_SECONDS = 30 * 24 * 3600;

// ─── Cache key construction ─────────────────────────────────────────────

/**
 * Construct an ISR cache key for an App Router page, matching the runtime
 * `__isrCacheKey(pathname, suffix)` in the generated RSC entry exactly.
 *
 * Format: `app:[buildId:]<pathname>:<suffix>`
 * Long keys (>200 chars): `app:[buildId:]__hash:<fnv1a64>:<suffix>`
 */
export function appPageCacheKey(
  pathname: string,
  suffix: "html" | "rsc" | "route",
  buildId?: string,
): string {
  const normalized = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  const prefix = buildId ? `app:${buildId}` : "app";
  const key = `${prefix}:${normalized}:${suffix}`;
  if (key.length <= 200) return key;
  return `${prefix}:__hash:${fnv1a64(normalized)}:${suffix}`;
}

// ─── Tag construction ───────────────────────────────────────────────────

/**
 * Build cache tags for a page, matching the runtime `__pageCacheTags(pathname)`
 * in the generated RSC entry exactly.
 *
 * Produces: pathname, _N_T_ prefixed pathname, root layout tag, intermediate
 * layout tags for each segment, and a leaf page tag.
 */
export function buildPageTags(pathname: string): string[] {
  const tags = [pathname, `_N_T_${pathname}`];
  tags.push("_N_T_/layout");
  const segments = pathname.split("/");
  let built = "";
  for (let i = 1; i < segments.length; i++) {
    if (segments[i]) {
      built += "/" + segments[i];
      tags.push(`_N_T_${built}/layout`);
    }
  }
  tags.push(`_N_T_${built}/page`);
  return tags;
}

// ─── Entry serialization ────────────────────────────────────────────────

interface AppPageValue {
  kind: "APP_PAGE";
  html: string;
  rscData?: Buffer;
  headers?: Record<string, string | string[]>;
  postponed?: string;
  status: number;
}

/**
 * Build a serialized KVCacheEntry JSON string matching the format that
 * KVCacheHandler.get() expects at runtime.
 *
 * rscData (Buffer) is base64-encoded. Other fields pass through as-is.
 */
export function buildKVCacheEntryJSON(
  value: AppPageValue,
  tags: string[],
  revalidateSeconds: number | false,
): string {
  const now = Date.now();
  const revalidateAt =
    typeof revalidateSeconds === "number" && revalidateSeconds > 0
      ? now + revalidateSeconds * 1000
      : null;

  const serializedValue = {
    kind: value.kind,
    html: value.html,
    rscData: value.rscData ? value.rscData.toString("base64") : undefined,
    headers: value.headers,
    postponed: value.postponed,
    status: value.status,
  };

  return JSON.stringify({
    value: serializedValue,
    tags,
    lastModified: now,
    revalidateAt,
  });
}

// ─── Route entry construction ───────────────────────────────────────────

export interface KVBulkPair {
  key: string;
  value: string;
  expiration_ttl?: number;
}

/**
 * Build KV bulk API pairs for a single pre-rendered route.
 *
 * Produces up to 2 entries:
 * - `:html` entry with the rendered HTML (always)
 * - `:rsc` entry with the RSC payload (when rscBuffer is provided)
 */
export function buildRouteEntries(
  pathname: string,
  html: string,
  rscBuffer: Buffer | null,
  revalidate: number | false,
  buildId: string,
  appPrefix?: string,
): KVBulkPair[] {
  const kvPrefix = appPrefix ? `${appPrefix}:${ENTRY_PREFIX}` : ENTRY_PREFIX;
  const tags = buildPageTags(pathname);
  const expiration_ttl =
    typeof revalidate === "number" && revalidate > 0 ? KV_TTL_SECONDS : undefined;

  const pairs: KVBulkPair[] = [
    {
      key: `${kvPrefix}${appPageCacheKey(pathname, "html", buildId)}`,
      value: buildKVCacheEntryJSON({ kind: "APP_PAGE", html, status: 200 }, tags, revalidate),
      expiration_ttl,
    },
  ];

  if (rscBuffer) {
    pairs.push({
      key: `${kvPrefix}${appPageCacheKey(pathname, "rsc", buildId)}`,
      value: buildKVCacheEntryJSON(
        { kind: "APP_PAGE", html: "", rscData: rscBuffer, status: 200 },
        tags,
        revalidate,
      ),
      expiration_ttl,
    });
  }

  return pairs;
}

// ─── Bulk upload ────────────────────────────────────────────────────────

const MAX_BATCH_COUNT = 10_000;
const MAX_BATCH_BYTES = 95 * 1024 * 1024; // 95 MB (5 MB headroom from 100 MB limit)

/**
 * Upload KV entries via the Cloudflare REST bulk API.
 * Batches by entry count (max 10,000) and payload byte size (max ~95 MB).
 */
export async function uploadBulkToKV(
  pairs: KVBulkPair[],
  namespaceId: string,
  accountId: string,
  apiToken: string,
): Promise<void> {
  const batches: KVBulkPair[][] = [];
  let currentBatch: KVBulkPair[] = [];
  let currentBytes = 0;

  for (const pair of pairs) {
    const pairBytes = Buffer.byteLength(pair.key) + Buffer.byteLength(pair.value);

    if (
      currentBatch.length >= MAX_BATCH_COUNT ||
      (currentBatch.length > 0 && currentBytes + pairBytes > MAX_BATCH_BYTES)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(pair);
    currentBytes += pairBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  for (let i = 0; i < batches.length; i++) {
    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(batches[i]),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `KV bulk upload failed (batch ${i + 1}/${batches.length}): ${response.status} — ${text}`,
      );
    }
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────

interface PrerenderManifestRoute {
  route: string;
  status: string;
  revalidate?: number | false;
  path?: string;
  /** Router type — only "app" routes are seeded (Pages Router has a different key/value schema). */
  router?: "app" | "pages";
}

interface PrerenderManifest {
  buildId?: string;
  trailingSlash?: boolean;
  routes: PrerenderManifestRoute[];
}

export interface PopulateKVOptions {
  root: string;
  accountId: string;
  namespaceId: string;
  apiToken: string;
  appPrefix?: string;
}

export interface PopulateKVResult {
  routesProcessed: number;
  entriesUploaded: number;
  skipped?: string;
  durationMs: number;
}

/**
 * Populate Workers KV with pre-rendered pages from the build output.
 *
 * Reads the prerender manifest and HTML/RSC files, constructs cache entries
 * matching the runtime format exactly, and uploads via the Cloudflare bulk API.
 */
export async function populateKV(options: PopulateKVOptions): Promise<PopulateKVResult> {
  const start = performance.now();
  const serverDir = path.join(options.root, "dist", "server");
  const manifestPath = path.join(serverDir, "vinext-prerender.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      routesProcessed: 0,
      entriesUploaded: 0,
      skipped: "no prerender manifest",
      durationMs: 0,
    };
  }

  const manifest: PrerenderManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  if (!manifest.buildId) {
    return {
      routesProcessed: 0,
      entriesUploaded: 0,
      skipped: "manifest missing buildId",
      durationMs: 0,
    };
  }

  const prerenderDir = path.join(serverDir, "prerendered-routes");
  const trailingSlash = manifest.trailingSlash ?? false;
  const allPairs: KVBulkPair[] = [];
  let routesProcessed = 0;

  for (const route of manifest.routes) {
    if (route.status !== "rendered") continue;
    // Only seed App Router routes — Pages Router uses different keys (pages:...)
    // and a different value shape (kind: "PAGES"). The router field is set by
    // PR #653's enriched manifest; routes without it are skipped defensively.
    if (route.router !== "app") continue;

    const pathname = route.path ?? route.route;
    const htmlFile = path.join(prerenderDir, getOutputPath(pathname, trailingSlash));

    if (!fs.existsSync(htmlFile)) continue;

    const html = fs.readFileSync(htmlFile, "utf-8");
    const rscFile = path.join(prerenderDir, getRscOutputPath(pathname));
    const rscBuffer = fs.existsSync(rscFile) ? fs.readFileSync(rscFile) : null;

    const pairs = buildRouteEntries(
      pathname,
      html,
      rscBuffer,
      route.revalidate ?? false,
      manifest.buildId,
      options.appPrefix,
    );

    allPairs.push(...pairs);
    routesProcessed++;
  }

  if (allPairs.length > 0) {
    await uploadBulkToKV(allPairs, options.namespaceId, options.accountId, options.apiToken);
  }

  return {
    routesProcessed,
    entriesUploaded: allPairs.length,
    durationMs: performance.now() - start,
  };
}
