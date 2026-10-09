import fs from "node:fs";
import path from "pathslash";
import { toClientRewrites, type ClientRewrites } from "../client/client-rewrites.js";
import type { ResolvedNextConfig } from "../config/next-config.js";
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
  /** The app's Pages Router routes (pages/ and pages/api), in Next.js format. */
  pages: readonly string[];
};

/**
 * Next.js always builds an `_app` and an `_error` entry (its defaults when the
 * app has none) and lists both in `sortedPages`.
 */
const GLOBAL_PAGES = ["/_app", "/_error"];

export function buildNextClientBuildManifestContent(
  rewrites: ResolvedNextConfig["rewrites"],
  pages: readonly string[],
): string {
  const manifest: ClientRuntimeBuildManifest = {
    __rewrites: toClientRewrites(rewrites),
    sortedPages: getSortedRoutes([...pages, ...GLOBAL_PAGES]),
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
