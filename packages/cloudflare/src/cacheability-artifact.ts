import fs from "node:fs";
import path from "node:path";
import { CACHEABILITY_MANIFEST_PLACEHOLDER } from "vinext/internal/server/cacheability-manifest";
import type { CacheabilityManifest } from "vinext/internal/server/cacheability-manifest";

function collectServerJavaScript(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectServerJavaScript(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Embed a version-specific cacheability manifest into an isolated copy of the
 * server output for one synchronous Wrangler upload.
 *
 * Vinext's RSC build emits multiple pre-bundled Worker modules and Wrangler's
 * `--define` does not transform those attached modules. Replacing the explicit
 * identifier in the finished server artifacts avoids a second application
 * build while ensuring every independently bundled router copy sees the same
 * manifest. Keeping the reusable build immutable also makes a failed or
 * interrupted upload safe for later deploy attempts.
 */
export function withEmbeddedCacheabilityManifest<T>(
  root: string,
  configuredPath: string | undefined,
  manifest: CacheabilityManifest,
  upload: (configPath: string) => T,
): T {
  const distDirectory = path.join(root, "dist");
  const configPath = path.resolve(root, configuredPath ?? "dist/server/wrangler.json");
  const relativeConfigPath = path.relative(distDirectory, configPath);
  if (relativeConfigPath.startsWith("..") || path.isAbsolute(relativeConfigPath)) {
    throw new Error(
      "Two-stage CDN warming requires the generated Wrangler config under dist/. Pass --config dist/server/wrangler.json (or another generated dist config).",
    );
  }
  const serverDirectory = path.dirname(configPath);
  const isolatedServerDirectory = fs.mkdtempSync(path.join(distDirectory, ".vinext-cacheability-"));
  const placeholderLiterals = [
    JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER),
    `'${CACHEABILITY_MANIFEST_PLACEHOLDER}'`,
    `\`${CACHEABILITY_MANIFEST_PLACEHOLDER}\``,
  ];
  const replacement = JSON.stringify(JSON.stringify(manifest));
  let replacements = 0;

  try {
    fs.cpSync(serverDirectory, isolatedServerDirectory, { recursive: true });
    for (const filePath of collectServerJavaScript(isolatedServerDirectory)) {
      const content = fs.readFileSync(filePath, "utf-8");
      const presentLiterals = placeholderLiterals.filter((literal) => content.includes(literal));
      if (presentLiterals.length === 0) continue;
      replacements += 1;
      fs.writeFileSync(
        filePath,
        presentLiterals.reduce(
          (embedded, literal) => embedded.replaceAll(literal, replacement),
          content,
        ),
      );
    }

    if (replacements === 0) {
      throw new Error(
        "Cannot embed the cacheability manifest because its placeholder was not found in dist/server. Rebuild the app before deploying.",
      );
    }

    const isolatedConfigPath = path.relative(
      root,
      path.join(isolatedServerDirectory, path.basename(configPath)),
    );
    return upload(isolatedConfigPath);
  } finally {
    fs.rmSync(isolatedServerDirectory, { recursive: true, force: true });
  }
}
