import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

const ASSET_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function isExternalSpecifier(specifier: string): boolean {
  try {
    return new URL(specifier).protocol !== "";
  } catch {
    return false;
  }
}

function shouldInlineSpecifier(specifier: string): boolean {
  if (isExternalSpecifier(specifier)) return false;
  return Object.hasOwn(ASSET_MIME_TYPES, path.extname(specifier).toLowerCase());
}

function resolveAssetPath(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return path.resolve(path.dirname(importer), specifier);
  }

  try {
    return createRequire(importer).resolve(specifier);
  } catch {
    return null;
  }
}

export async function transformEdgeBlobAssetUrls(
  code: string,
  id: string,
  readFile: (filePath: string) => Promise<Buffer> = fs.promises.readFile,
): Promise<string | null> {
  if (!code.includes("import.meta.url")) return null;

  const pattern = /new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;

  let output = code;
  let didReplace = false;

  for (const match of code.matchAll(pattern)) {
    const fullMatch = match[0];
    const specifier = match[2];
    if (!shouldInlineSpecifier(specifier)) continue;

    const assetPath = resolveAssetPath(specifier, id);
    if (!assetPath) continue;

    let asset: Buffer;
    try {
      asset = await readFile(assetPath);
    } catch {
      continue;
    }

    const mimeType =
      ASSET_MIME_TYPES[path.extname(specifier).toLowerCase()] ?? "application/octet-stream";
    const dataUrl = `data:${mimeType};base64,${asset.toString("base64")}`;

    output = output.replaceAll(fullMatch, `new URL(${JSON.stringify(dataUrl)})`);
    didReplace = true;
  }

  return didReplace ? output : null;
}

export function createEdgeBlobAssetsPlugin(): Plugin {
  return {
    name: "vinext:edge-blob-assets",
    enforce: "pre",
    async transform(code, id) {
      if (this.environment?.name === "client") return null;
      const transformed = await transformEdgeBlobAssetUrls(code, id);
      return transformed ? { code: transformed, map: null } : null;
    },
  };
}
