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
import { appIsrCacheKey } from "vinext/internal/server/isr-cache";
import { buildAppPageCacheTags } from "vinext/internal/server/app-page-cache";
import {
  getRenderedAppRoutes,
  readPrerenderManifest,
} from "vinext/internal/server/prerender-manifest";
import { normalizePregeneratedPathname } from "vinext/internal/server/pregenerated-concrete-paths";
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

function resolveContainedFile(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[vinext] Refusing to read prerender artifact outside ${resolvedRoot}`);
  }
  return resolvedFile;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
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
    let htmlPath: string;
    let rscPath: string;
    try {
      htmlPath = resolveContainedFile(prerenderDir, getOutputPath(artifactPathname, trailingSlash));
      rscPath = resolveContainedFile(prerenderDir, getRscOutputPath(artifactPathname));
    } catch (error) {
      console.warn(
        `[vinext] Skipping prerender KV seed for ${artifactPathname}: ${formatUnknownError(error)}`,
      );
      continue;
    }
    if (!fs.existsSync(htmlPath)) continue;

    const revalidateSeconds =
      typeof route.revalidate === "number" && route.revalidate > 0 ? route.revalidate : undefined;
    const expireSeconds = typeof route.expire === "number" ? route.expire : undefined;
    const expirationTtl = revalidateSeconds === undefined ? undefined : ttlSeconds;
    const tags = buildAppPageCacheTags(cachePathname, []);
    const metadata = buildMetadata(tags);
    const htmlKey = appIsrCacheKey(cachePathname, "html", manifest.buildId);
    const rscKey = appIsrCacheKey(cachePathname, "rsc", manifest.buildId);

    pairs.push({
      key: buildKVKey(options?.appPrefix, htmlKey),
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

    if (fs.existsSync(rscPath)) {
      const rscData = fs.readFileSync(rscPath).toString("base64");
      pairs.push({
        key: buildKVKey(options?.appPrefix, rscKey),
        value: buildCacheEntry(
          {
            kind: "APP_PAGE",
            html: "",
            rscData,
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
