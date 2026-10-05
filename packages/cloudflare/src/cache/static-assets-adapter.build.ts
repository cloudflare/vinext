import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appIsrCacheKey, pagesIsrCacheKey } from "vinext/internal/server/isr-cache";
import { extractVinextNextDataJson } from "vinext/internal/client/vinext-next-data";
import {
  getAppPageArtifactPathname,
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

function pagesCacheKey(pathname: string, locale: string | undefined, buildId: string): string {
  // Strip the explicit prerender locale, just as the request handler does.
  let pagesPathname = new URL(`https://vinext.invalid${pathname}`).pathname;
  if (locale) {
    const prefix = `/${locale}`;
    if (pagesPathname === prefix) pagesPathname = "/";
    else if (pagesPathname.startsWith(`${prefix}/`))
      pagesPathname = pagesPathname.slice(prefix.length);
  }
  return pagesIsrCacheKey(pagesPathname, buildId, locale ? `locale:${locale}` : undefined);
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
  contents?: string,
): boolean {
  if (!fs.existsSync(sourcePath)) return false;

  const id = cacheAssetId(key);
  const extension = kind;
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
      // A rewritten source URL has its own artifact files and its own key.
      const artifactPathname = getAppPageArtifactPathname(route);
      const appCachePathname = route.rewrite ? route.rewrite.cachePathname : cachePathname;
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appIsrCacheKey(appCachePathname, "html", manifest.buildId),
          "html",
          path.join(prerenderDir, getOutputPath(artifactPathname, manifest.trailingSlash ?? false)),
          route,
        ),
      );
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          appIsrCacheKey(appCachePathname, "rsc", manifest.buildId),
          "rsc",
          path.join(prerenderDir, getRscOutputPath(artifactPathname)),
          route,
        ),
      );
    } else if (route.router === "pages") {
      const sourcePath = path.join(
        prerenderDir,
        getOutputPath(pathname, manifest.trailingSlash ?? false),
      );
      if (!fs.existsSync(sourcePath)) continue;
      const html = fs.readFileSync(sourcePath, "utf8");
      const key = pagesCacheKey(pathname, route.locale, manifest.buildId);
      if (route.notFound) {
        count += Number(
          writeCacheAsset(outputDir, index, key, "not-found", sourcePath, route, "null"),
        );
        continue;
      }
      if (route.redirectProps) {
        count += Number(
          writeCacheAsset(
            outputDir,
            index,
            key,
            "redirect",
            sourcePath,
            route,
            JSON.stringify(route.redirectProps),
          ),
        );
        continue;
      }
      const json = extractVinextNextDataJson(html);
      // Only GSP terminal results receive manifest metadata above. Redirects
      // produced before page rendering must keep running at request time.
      if (json === null) continue;
      const nextData = JSON.parse(json) as {
        props?: object;
        gsp?: boolean;
        autoExport?: boolean;
        locale?: string;
      };
      // Do not freeze getInitialProps/SSR pages that a source-only prerender
      // classification may have admitted (for example, custom _app props).
      if (nextData.gsp !== true && nextData.autoExport !== true) continue;
      if (!nextData.props || typeof nextData.props !== "object") {
        throw new Error(`[vinext] Missing prerendered Pages props for ${pathname}`);
      }
      count += Number(
        writeCacheAsset(
          outputDir,
          index,
          pagesCacheKey(pathname, nextData.locale ?? route.locale, manifest.buildId),
          "pages",
          sourcePath,
          {
            ...route,
            responseStatus:
              route.route === "/404"
                ? 404
                : route.route === "/500"
                  ? 500
                  : (route.responseStatus ?? 200),
          },
          JSON.stringify({ html, pageData: nextData.props }),
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
