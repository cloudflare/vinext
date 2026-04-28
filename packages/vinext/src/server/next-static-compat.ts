import fs from "node:fs";
import path from "node:path";

const NEXT_STATIC_PREFIX = "/_next/static/";

export function isNextStaticAssetPath(pathname: string): boolean {
  return pathname === "/_next/static" || pathname.startsWith(NEXT_STATIC_PREFIX);
}

function normalizeAssetPrefixPath(assetPrefix?: string | null): string {
  if (!assetPrefix) return "";

  let pathname = assetPrefix;
  try {
    pathname = new URL(assetPrefix).pathname;
  } catch {
    // Path-style asset prefixes are already pathnames.
  }

  if (!pathname.startsWith("/")) return "";
  return pathname.replace(/\/+$/, "");
}

export function getNextStaticAssetLookupPath(
  pathname: string,
  assetPrefix?: string | null,
): string {
  if (isNextStaticAssetPath(pathname)) return pathname;

  const prefixPath = normalizeAssetPrefixPath(assetPrefix);
  if (!prefixPath || prefixPath === "/") return pathname;
  if (pathname !== prefixPath && !pathname.startsWith(`${prefixPath}/`)) return pathname;

  const stripped = pathname.slice(prefixPath.length) || "/";
  return isNextStaticAssetPath(stripped) ? stripped : pathname;
}

export function writeNextStaticCompatAssets(clientDir: string, buildId: string): void {
  if (!buildId) return;

  const staticDir = path.join(clientDir, "_next", "static", buildId);
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, "_buildManifest.js"),
    [
      "self.__BUILD_MANIFEST = {};",
      "self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB();",
      "",
    ].join("\n"),
  );
}
