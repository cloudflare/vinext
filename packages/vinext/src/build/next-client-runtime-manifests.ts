import fs from "node:fs";
import path from "pathslash";
import { toClientRewrites, type ClientRewrites } from "../client/client-rewrites.js";
import type { ResolvedNextConfig } from "../config/next-config.js";

type ClientRuntimeBuildManifest = {
  __rewrites: ClientRewrites;
  sortedPages: string[];
};

type EmitNextClientRuntimeManifestsOptions = {
  clientDir: string;
  assetsSubdir: string;
  buildId: string;
  rewrites: ResolvedNextConfig["rewrites"];
};

export function buildNextClientBuildManifestContent(
  rewrites: ResolvedNextConfig["rewrites"],
): string {
  const manifest: ClientRuntimeBuildManifest = {
    __rewrites: toClientRewrites(rewrites),
    sortedPages: [],
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
    buildNextClientBuildManifestContent(options.rewrites),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(manifestDir, "_ssgManifest.js"),
    buildNextClientSsgManifestContent(),
    "utf-8",
  );
}
