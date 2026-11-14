import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appIsrCacheKey, appIsrFallbackShellKey } from "vinext/internal/server/isr-cache";
import {
  prerenderedCacheControl,
  prerenderedPagesCacheKey,
  readPrerenderedPagesValue,
} from "vinext/internal/server/prerendered-pages";
import {
  isFallbackShellArtifactPath,
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

function writeCacheAsset(
  outputDir: string,
  index: StaticAssetCacheIndex,
  key: string,
  kind: StaticAssetCacheMetadata["kind"],
  sourcePath: string,
  route: PrerenderManifestRoute,
  contents?: string,
): boolean {
  if (!fs.existsSync(sourcePath)) return false;

  const id = cacheAssetId(key);
  const extension = kind;
  const policy = prerenderedCacheControl(route);
  // A page's special error that escaped the shell keeps its status on the RSC
  // entry too, and a redirect its location, as runtime ISR stores it.
  const headers =
    kind !== "rsc"
      ? route.headers
      : route.responseStatus !== undefined && route.headers?.location !== undefined
        ? { location: route.headers.location }
        : undefined;
  const metadata: StaticAssetCacheMetadata = {
    kind,
    lastModified: fs.statSync(sourcePath).mtimeMs,
    ...(policy ? { cacheControl: policy } : {}),
    ...(headers ? { headers } : {}),
    ...(route.responseStatus !== undefined ? { status: route.responseStatus } : {}),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${id}.${extension}`);
  if (contents === undefined) fs.copyFileSync(sourcePath, outputPath);
  else fs.writeFileSync(outputPath, contents);
  index[id] = metadata;
  return true;
}

/** Package prerender output from both routers as immutable Workers Static Assets. */
export function finalizeStaticAssetsPrerenderOutput(
  root: string,
  options: { clientOutDir?: string } = {},
): number {
  const serverDir = path.join(root, "dist", "server");
  const prerenderDir = path.join(serverDir, "prerendered-routes");
  const outputDir = path.join(
    options.clientOutDir ?? path.join(root, "dist", "client"),
    STATIC_ASSET_CACHE_PATH.replace(/^\//, ""),
  );
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
      const appKey = isFallbackShellArtifactPath(pathname, route)
        ? appIsrFallbackShellKey
        : appIsrCacheKey;
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appKey(cachePathname, "html", manifest.buildId),
          "html",
          path.join(prerenderDir, getOutputPath(pathname, manifest.trailingSlash ?? false)),
          route,
        ),
      );
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appKey(cachePathname, "rsc", manifest.buildId),
          "rsc",
          path.join(prerenderDir, getRscOutputPath(pathname)),
          route,
        ),
      );
    } else if (route.router === "pages") {
      const sourcePath = path.join(
        prerenderDir,
        getOutputPath(pathname, manifest.trailingSlash ?? false),
      );
      if (!fs.existsSync(sourcePath)) continue;
      const prerendered = readPrerenderedPagesValue(route, fs.readFileSync(sourcePath, "utf8"));
      if (prerendered === undefined) continue;
      const key = prerenderedPagesCacheKey(pathname, prerendered.locale, manifest.buildId);
      const { value } = prerendered;
      count += Number(
        value === null
          ? writeCacheAsset(outputDir, index, key, "not-found", sourcePath, route, "null")
          : value.kind === "REDIRECT"
            ? writeCacheAsset(
                outputDir,
                index,
                key,
                "redirect",
                sourcePath,
                route,
                JSON.stringify(value.props),
              )
            : writeCacheAsset(
                outputDir,
                index,
                key,
                "pages",
                sourcePath,
                { ...route, responseStatus: value.status },
                JSON.stringify({ html: value.html, pageData: value.pageData }),
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
