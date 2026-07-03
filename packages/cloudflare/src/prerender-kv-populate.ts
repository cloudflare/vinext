/**
 * Deploy-time KV population for App Router prerendered artifacts.
 *
 * Reads `dist/server/vinext-prerender.json` and `dist/server/prerendered-routes/*`,
 * converts rendered App Router HTML/RSC artifacts into the same serialized
 * KVCacheEntry shape written by KVCacheHandler.set(), then uploads them through
 * Cloudflare KV's bulk endpoint.
 */

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { isrCacheKey } from "vinext/internal/server/isr-cache";
import { buildAppPageCacheTags } from "vinext/internal/server/app-page-cache";
import {
  getRenderedAppRoutes,
  readPrerenderManifest,
} from "vinext/internal/server/prerender-manifest";
import { getOutputPath, getRscOutputPath } from "vinext/internal/utils/prerender-output-paths";
import { ENTRY_PREFIX } from "@vinext/cloudflare/cache/kv-data-adapter.runtime";
import { DEFAULT_KV_TTL_SECONDS, type KVBulkPair, uploadKVPairs } from "./kv-bulk.js";

export type PrerenderKVPopulationOptions = {
  accountId: string;
  apiToken: string;
  appPrefix?: string;
  namespaceId: string;
  serverDir: string;
  ttlSeconds?: number;
};

export type PrerenderKVPopulationResult =
  | {
      skipped?: undefined;
      routeCount: number;
      pairCount: number;
    }
  | {
      skipped: string;
      routeCount: 0;
      pairCount: 0;
    };

type CacheControlMetadata = {
  revalidate: number;
  expire?: number;
};

function normalizePregeneratedPathname(pathname: string): string {
  try {
    const decoded = decodeURI(pathname);
    return decoded === "/" ? "/" : decoded.replace(/\/$/, "");
  } catch {
    return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

function resolveContainedFile(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[vinext] Refusing to read prerender artifact outside ${resolvedRoot}`);
  }
  return resolvedFile;
}

function buildKVKey(appPrefix: string | undefined, cacheKey: string): string {
  return `${appPrefix ? `${appPrefix}:` : ""}${ENTRY_PREFIX}${cacheKey}`;
}

function buildCacheEntry(
  value: Record<string, unknown>,
  tags: string[],
  now: number,
  revalidateSeconds: number | undefined,
  expireSeconds: number | undefined,
): string {
  const cacheControl: CacheControlMetadata | undefined =
    revalidateSeconds === undefined
      ? undefined
      : expireSeconds === undefined
        ? { revalidate: revalidateSeconds }
        : { revalidate: revalidateSeconds, expire: expireSeconds };

  return JSON.stringify({
    value,
    tags,
    lastModified: now,
    revalidateAt: revalidateSeconds === undefined ? null : now + revalidateSeconds * 1000,
    expireAt: expireSeconds === undefined ? null : now + expireSeconds * 1000,
    ...(cacheControl ? { cacheControl } : {}),
  });
}

function buildMetadata(tags: string[]): Record<string, unknown> | undefined {
  const metadata = { tags };
  return JSON.stringify(metadata).length <= 1024 ? metadata : undefined;
}

export function buildPrerenderKVPairs(
  serverDir: string,
  options?: {
    appPrefix?: string;
    now?: number;
    ttlSeconds?: number;
  },
): { routeCount: number; pairs: KVBulkPair[] } {
  const manifestPath = path.join(serverDir, "vinext-prerender.json");
  const manifest = readPrerenderManifest(manifestPath);
  if (!manifest?.buildId || !Array.isArray(manifest.routes)) {
    return { routeCount: 0, pairs: [] };
  }

  const prerenderDir = path.join(serverDir, "prerendered-routes");
  if (!fs.existsSync(prerenderDir)) {
    return { routeCount: 0, pairs: [] };
  }

  const pairs: KVBulkPair[] = [];
  const now = options?.now ?? Date.now();
  const ttlSeconds = options?.ttlSeconds ?? DEFAULT_KV_TTL_SECONDS;
  const trailingSlash = manifest.trailingSlash ?? false;
  let routeCount = 0;

  for (const route of getRenderedAppRoutes(manifest.routes)) {
    const artifactPathname = route.path ?? route.route;
    const cachePathname = normalizePregeneratedPathname(artifactPathname);
    const htmlPath = resolveContainedFile(
      prerenderDir,
      getOutputPath(artifactPathname, trailingSlash),
    );
    if (!fs.existsSync(htmlPath)) continue;

    const revalidateSeconds = typeof route.revalidate === "number" ? route.revalidate : undefined;
    const expireSeconds = typeof route.expire === "number" ? route.expire : undefined;
    const expirationTtl = revalidateSeconds === undefined ? undefined : ttlSeconds;
    const tags = buildAppPageCacheTags(cachePathname, []);
    const metadata = buildMetadata(tags);
    const baseKey = isrCacheKey("app", cachePathname, manifest.buildId);

    pairs.push({
      key: buildKVKey(options?.appPrefix, `${baseKey}:html`),
      value: buildCacheEntry(
        {
          kind: "APP_PAGE",
          html: fs.readFileSync(htmlPath, "utf-8"),
          headers: route.headers,
        },
        tags,
        now,
        revalidateSeconds,
        expireSeconds,
      ),
      ...(expirationTtl !== undefined ? { expiration_ttl: expirationTtl } : {}),
      ...(metadata ? { metadata } : {}),
    });

    const rscPath = resolveContainedFile(prerenderDir, getRscOutputPath(artifactPathname));
    if (fs.existsSync(rscPath)) {
      const rscData = toArrayBuffer(fs.readFileSync(rscPath));
      pairs.push({
        key: buildKVKey(options?.appPrefix, `${baseKey}:rsc`),
        value: buildCacheEntry(
          {
            kind: "APP_PAGE",
            html: "",
            rscData: arrayBufferToBase64(rscData),
          },
          tags,
          now,
          revalidateSeconds,
          expireSeconds,
        ),
        ...(expirationTtl !== undefined ? { expiration_ttl: expirationTtl } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }

    routeCount++;
  }

  return { routeCount, pairs };
}

export async function populatePrerenderKVCache(
  options: PrerenderKVPopulationOptions,
): Promise<PrerenderKVPopulationResult> {
  const { routeCount, pairs } = buildPrerenderKVPairs(options.serverDir, {
    appPrefix: options.appPrefix,
    ttlSeconds: options.ttlSeconds,
  });

  if (pairs.length === 0) {
    return {
      skipped: "no App Router prerendered cache entries found",
      routeCount: 0,
      pairCount: 0,
    };
  }

  await uploadKVPairs(pairs, options.namespaceId, options.accountId, options.apiToken);
  return { routeCount, pairCount: pairs.length };
}
