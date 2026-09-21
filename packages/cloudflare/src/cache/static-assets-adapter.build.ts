import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appIsrCacheKey } from "vinext/internal/server/isr-cache";
import {
  readPrerenderManifest,
  type PrerenderManifestRoute,
} from "vinext/internal/server/prerender-manifest";
import { normalizePregeneratedPathname } from "vinext/internal/server/pregenerated-concrete-paths";
import {
  getAppRouteOutputPath,
  getOutputPath,
  getRscOutputPath,
} from "vinext/internal/utils/prerender-output-paths";
import {
  STATIC_ASSET_CACHE_PATH,
  type StaticAssetCacheIndex,
  type StaticAssetCacheMetadata,
} from "./static-assets-adapter.shared.js";

function cacheAssetId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function cacheControl(route: PrerenderManifestRoute) {
  if (route.revalidate === undefined) return undefined;
  return {
    revalidate: route.revalidate,
    ...(route.expire === undefined ? {} : { expire: route.expire }),
    ...(route.stale === undefined ? {} : { stale: route.stale }),
  };
}

function writeCacheAsset(
  outputDir: string,
  index: StaticAssetCacheIndex,
  key: string,
  kind: StaticAssetCacheMetadata["kind"],
  sourcePath: string,
  route: PrerenderManifestRoute,
): boolean {
  if (!fs.existsSync(sourcePath)) return false;

  const id = cacheAssetId(key);
  const extension = kind === "html" ? "html" : kind === "rsc" ? "rsc" : "route";
  const policy = cacheControl(route);
  const metadata: StaticAssetCacheMetadata = {
    kind,
    lastModified: fs.statSync(sourcePath).mtimeMs,
    ...(policy ? { cacheControl: policy } : {}),
    ...(kind !== "rsc" && route.headers ? { headers: route.headers } : {}),
    ...(kind !== "rsc" && route.responseStatus !== undefined
      ? { status: route.responseStatus }
      : {}),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(sourcePath, path.join(outputDir, `${id}.${extension}`));
  index[id] = metadata;
  return true;
}

/** Package App Router prerender output as immutable Workers Static Assets. */
export function finalizeStaticAssetsPrerenderOutput(root: string): number {
  const serverDir = path.join(root, "dist", "server");
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  const outputDir = path.join(root, "dist", "client", STATIC_ASSET_CACHE_PATH.replace(/^\//, ""));
  fs.rmSync(outputDir, { recursive: true, force: true });

  const manifest = readPrerenderManifest(path.join(serverDir, "vinext-prerender.json"));
  if (!manifest?.buildId || !manifest.routes || !fs.existsSync(prerenderDir)) return 0;

  const index: StaticAssetCacheIndex = {};
  let count = 0;
  for (const route of manifest.routes) {
    if (route.status !== "rendered") continue;
    if (typeof route.revalidate === "number" && route.revalidate <= 0) continue;

    const pathname = route.path ?? route.route;
    const cachePathname = normalizePregeneratedPathname(pathname);
    if (route.router === "app") {
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appIsrCacheKey(cachePathname, "html", manifest.buildId),
          "html",
          path.join(prerenderDir, getOutputPath(pathname, manifest.trailingSlash ?? false)),
          route,
        ),
      );
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appIsrCacheKey(cachePathname, "rsc", manifest.buildId),
          "rsc",
          path.join(prerenderDir, getRscOutputPath(pathname)),
          route,
        ),
      );
    } else if (route.router === "metadata") {
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appIsrCacheKey(cachePathname, "route", manifest.buildId),
          "route",
          path.join(prerenderDir, getAppRouteOutputPath(pathname)),
          route,
        ),
      );
    }
  }
  if (count > 0) fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify(index));
  return count;
}
