import fs from "node:fs";
import path from "node:path";
import { isUnknownRecord } from "../utils/record.js";

export type WranglerAssetsConfig = {
  directory?: string;
  notFoundHandling?: string;
};

export type WranglerAssetsConfigReadResult =
  | { assets: WranglerAssetsConfig | null; ok: true }
  | { ok: false };

function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index++;
      }
      index++;
      continue;
    }

    output += char;
  }
  return output;
}

function parseJsonOrJsonc(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/g, "$1"));
  }
}

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
    return parseJsonOrJsonc(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
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

export function readRootWranglerAssetsConfig(
  root: string,
  envName: string | undefined,
): WranglerAssetsConfigReadResult {
  const wranglerPath = ["wrangler.jsonc", "wrangler.json"]
    .map((filename) => path.join(root, filename))
    .find((candidate) => fs.existsSync(candidate));
  if (!wranglerPath) return { ok: true, assets: null };

  const parsed = readJsonWranglerConfig(wranglerPath);
  if (!isUnknownRecord(parsed)) return { ok: false };

  return toAssetsConfig(resolveEnvironmentAssetsConfig(parsed, envName));
}

export function readEmittedWranglerAssetsConfig(serverDir: string): WranglerAssetsConfigReadResult {
  const wranglerPath = path.join(serverDir, "wrangler.json");
  if (!fs.existsSync(wranglerPath)) return { ok: true, assets: null };

  const parsed = readJsonWranglerConfig(wranglerPath);
  if (!isUnknownRecord(parsed)) return { ok: false };

  return toAssetsConfig(parsed.assets);
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
