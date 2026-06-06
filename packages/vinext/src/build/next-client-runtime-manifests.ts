import fs from "node:fs";
import path from "node:path";
import type { NextRewrite, ResolvedNextConfig } from "../config/next-config.js";

type ClientRuntimeRewrite = {
  source: string;
  destination?: string;
  has?: NextRewrite["has"];
};

type ClientRuntimeRewrites = {
  beforeFiles: ClientRuntimeRewrite[];
  afterFiles: ClientRuntimeRewrite[];
  fallback: ClientRuntimeRewrite[];
};

type ClientRuntimeBuildManifest = {
  __rewrites: ClientRuntimeRewrites;
  sortedPages: string[];
};

type EmitNextClientRuntimeManifestsOptions = {
  clientDir: string;
  assetsSubdir: string;
  buildId: string;
  rewrites: ResolvedNextConfig["rewrites"];
};

function normalizeRewriteForClientManifest(rewrite: NextRewrite): ClientRuntimeRewrite {
  if (rewrite.destination.startsWith("/")) {
    return { has: rewrite.has, source: rewrite.source, destination: rewrite.destination };
  }

  return { has: rewrite.has, source: rewrite.source };
}

function normalizeRewritesForClientManifest(
  rewrites: ResolvedNextConfig["rewrites"],
): ClientRuntimeRewrites {
  return {
    beforeFiles: rewrites.beforeFiles.map(normalizeRewriteForClientManifest),
    afterFiles: rewrites.afterFiles.map(normalizeRewriteForClientManifest),
    fallback: rewrites.fallback.map(normalizeRewriteForClientManifest),
  };
}

export function buildNextClientBuildManifestContent(
  rewrites: ResolvedNextConfig["rewrites"],
): string {
  const manifest: ClientRuntimeBuildManifest = {
    __rewrites: normalizeRewritesForClientManifest(rewrites),
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
