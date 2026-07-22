import fs from "node:fs";
import path from "pathslash";
import { resolveAssetsDir, resolveAssetUrlPrefix } from "../utils/asset-prefix.js";

type InlineCssManifest = Record<string, string>;

const INLINE_CSS_GLOBAL_MARKER = "globalThis.__VINEXT_INLINE_CSS__ = ";

function collectCssFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectCssFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push(filePath);
    }
  }

  return files;
}

function addPathnameAlias(manifest: InlineCssManifest, href: string, css: string): void {
  try {
    const url = new URL(href);
    manifest[url.pathname] = css;
  } catch {
    // Relative asset URLs are already keyed by their emitted href.
  }
}

export function collectInlineCssManifest(
  clientDir: string,
  assetPrefix: string,
): InlineCssManifest {
  const assetsDir = path.join(clientDir, resolveAssetsDir(assetPrefix));
  if (!fs.existsSync(assetsDir)) return {};

  const urlPrefix = resolveAssetUrlPrefix(assetPrefix);
  const manifest: InlineCssManifest = {};

  for (const filePath of collectCssFiles(assetsDir)) {
    const relativePath = path.relative(assetsDir, filePath);
    const href = `${urlPrefix}${relativePath}`;
    const css = fs.readFileSync(filePath, "utf8");
    manifest[href] = css;
    addPathnameAlias(manifest, href, css);
  }

  return manifest;
}

function createInlineCssManifestGlobalCode(manifest: InlineCssManifest): string {
  return `${INLINE_CSS_GLOBAL_MARKER}${JSON.stringify(manifest)};`;
}

export function injectInlineCssManifestGlobal(
  entryPath: string,
  manifest: InlineCssManifest,
): boolean {
  if (Object.keys(manifest).length === 0 || !fs.existsSync(entryPath)) return false;

  const code = fs.readFileSync(entryPath, "utf8");
  if (code.includes(INLINE_CSS_GLOBAL_MARKER)) return false;

  fs.writeFileSync(entryPath, `${createInlineCssManifestGlobalCode(manifest)}\n${code}`);
  return true;
}
