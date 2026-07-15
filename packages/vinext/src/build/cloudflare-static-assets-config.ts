import fs from "node:fs";
import path from "pathslash";
import { parseJsonc } from "../utils/jsonc.js";
import { resolveWranglerJsonPath } from "../utils/project.js";
import { isUnknownRecord } from "../utils/record.js";

export type WranglerAssetsConfig = {
  directory?: string;
  notFoundHandling?: string;
};

export type WranglerAssetsConfigReadResult =
  | { assets: WranglerAssetsConfig | null; ok: true }
  | { ok: false };

function toAssetsConfig(value: unknown): WranglerAssetsConfigReadResult {
  if (value === undefined) return { ok: true, assets: null };
  if (!isUnknownRecord(value)) return { ok: false };

  const directory = value.directory;
  const notFoundHandling = value.not_found_handling;
  return {
    ok: true,
    assets: {
      directory: typeof directory === "string" && directory.length > 0 ? directory : undefined,
      notFoundHandling: typeof notFoundHandling === "string" ? notFoundHandling : undefined,
    },
  };
}

function readJsonWranglerConfig(filePath: string): unknown {
  try {
    return parseJsonc(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function readAssetsConfigFromPath(
  wranglerPath: string | null,
  resolveAssets: (parsed: Record<string, unknown>) => unknown,
): WranglerAssetsConfigReadResult {
  if (!wranglerPath) return { ok: true, assets: null };

  const parsed = readJsonWranglerConfig(wranglerPath);
  if (!isUnknownRecord(parsed)) return { ok: false };

  return toAssetsConfig(resolveAssets(parsed));
}

function resolveEnvironmentAssetsConfig(parsed: unknown, envName: string | undefined): unknown {
  if (!isUnknownRecord(parsed)) return undefined;

  const topLevelAssets = parsed.assets;
  if (!envName || !isUnknownRecord(parsed.env)) return topLevelAssets;

  const envConfig = parsed.env[envName];
  if (!isUnknownRecord(envConfig) || !Object.hasOwn(envConfig, "assets")) {
    return topLevelAssets;
  }

  const envAssets = envConfig.assets;
  if (isUnknownRecord(topLevelAssets) && isUnknownRecord(envAssets)) {
    return { ...topLevelAssets, ...envAssets };
  }
  return envAssets;
}

/**
 * Wrangler config formats this reader cannot parse. When one exists without a
 * JSON/JSONC config, the assets config is unknown — callers gate transport on
 * a proven `not_found_handling`, so unknown must read as unreadable (`ok:
 * false`), not as "no config".
 */
const UNSUPPORTED_WRANGLER_CONFIG_FILES = ["wrangler.toml", "cloudflare.config.ts"];

function hasUnsupportedWranglerConfig(root: string): boolean {
  return UNSUPPORTED_WRANGLER_CONFIG_FILES.some((fileName) =>
    fs.existsSync(path.join(root, fileName)),
  );
}

export function readRootWranglerAssetsConfig(
  root: string,
  envName: string | undefined,
): WranglerAssetsConfigReadResult {
  const wranglerPath = resolveWranglerJsonPath(root);
  if (wranglerPath === null && hasUnsupportedWranglerConfig(root)) {
    return { ok: false };
  }
  return readAssetsConfigFromPath(wranglerPath, (parsed) =>
    resolveEnvironmentAssetsConfig(parsed, envName),
  );
}

export function readEmittedWranglerAssetsConfig(serverDir: string): WranglerAssetsConfigReadResult {
  const wranglerPath = path.join(serverDir, "wrangler.json");
  return readAssetsConfigFromPath(
    fs.existsSync(wranglerPath) ? wranglerPath : null,
    (parsed) => parsed.assets,
  );
}

export function isCloudflareRscTransportAllowedForAssetsConfig(
  assetsConfig: WranglerAssetsConfig | null,
): boolean {
  return (
    assetsConfig === null ||
    assetsConfig.notFoundHandling === undefined ||
    assetsConfig.notFoundHandling === "none"
  );
}
