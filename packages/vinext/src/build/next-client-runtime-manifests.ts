import fs from "node:fs";
import path from "pathslash";
import { toClientRewrites, type ClientRewrites } from "../client/client-rewrites.js";
import type { ResolvedNextConfig } from "../config/next-config.js";
import type { ValidFileMatcher } from "../routing/file-matcher.js";
import { getSortedRoutes } from "../routing/route-validation.js";

type ClientRuntimeBuildManifest = {
  __rewrites: ClientRewrites;
  sortedPages: string[];
};

type EmitNextClientRuntimeManifestsOptions = {
  clientDir: string;
  assetsSubdir: string;
  buildId: string;
  rewrites: ResolvedNextConfig["rewrites"];
  /** Next.js-format paths of every `pages/` page and API route, e.g. "/posts/[id]". */
  pages: readonly string[];
};

/**
 * Next.js page key for a `pages/` file, e.g. "/posts/[id]". Keeps the raw file
 * name (no decoding), so `pages/caf%C3%A9.js` stays "/caf%C3%A9".
 * Ported from Next.js: packages/next/src/build/route-discovery.ts (`getPageFromPath`).
 */
export function getPagesManifestPage(
  pagesDir: string,
  filePath: string,
  matcher: Pick<ValidFileMatcher, "stripExtension">,
): string {
  const page = `/${matcher.stripExtension(path.relative(pagesDir, filePath))}`;
  const withoutIndex = page.endsWith("/index") ? page.slice(0, -"/index".length) : page;
  return withoutIndex === "" ? "/" : withoutIndex;
}

export function buildNextClientBuildManifestContent(
  rewrites: ResolvedNextConfig["rewrites"],
  pages: readonly string[],
): string {
  // Next.js always lists `/_app` and `/_error` alongside the `pages/` routes
  // (including API routes under Turbopack), even for App Router-only builds.
  // Ported from Next.js: packages/next/src/shared/lib/turbopack/manifest-loader.ts
  // (`writeClientBuildManifest`).
  const manifest: ClientRuntimeBuildManifest = {
    __rewrites: toClientRewrites(rewrites),
    sortedPages: getSortedRoutes([...pages, "/_app", "/_error"]),
  };
  return `self.__BUILD_MANIFEST = ${JSON.stringify(manifest)};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()`;
}

export function buildNextClientSsgManifestContent(): string {
  return "self.__SSG_MANIFEST=new Set;self.__SSG_MANIFEST_CB&&self.__SSG_MANIFEST_CB()";
}

export function emitNextClientRuntimeManifests(
  options: EmitNextClientRuntimeManifestsOptions,
): void {
  const manifestDir = path.join(options.clientDir, options.assetsSubdir, options.buildId);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "_buildManifest.js"),
    buildNextClientBuildManifestContent(options.rewrites, options.pages),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(manifestDir, "_ssgManifest.js"),
    buildNextClientSsgManifestContent(),
    "utf-8",
  );
}
