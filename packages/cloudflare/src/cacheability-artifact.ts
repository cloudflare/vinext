import fs from "node:fs";
import path from "node:path";
import { CACHEABILITY_MANIFEST_DEFINE } from "vinext/internal/server/cacheability-manifest";
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
  manifest: CacheabilityManifest,
  upload: (configPath: string) => T,
): T {
  const distDirectory = path.join(root, "dist");
  const serverDirectory = path.join(distDirectory, "server");
  const isolatedServerDirectory = fs.mkdtempSync(path.join(distDirectory, ".vinext-cacheability-"));
  const replacement = JSON.stringify(JSON.stringify(manifest));
  let replacements = 0;

  try {
    fs.cpSync(serverDirectory, isolatedServerDirectory, { recursive: true });
    for (const filePath of collectServerJavaScript(isolatedServerDirectory)) {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes(CACHEABILITY_MANIFEST_DEFINE)) continue;
      replacements += 1;
      fs.writeFileSync(filePath, content.replaceAll(CACHEABILITY_MANIFEST_DEFINE, replacement));
    }

    if (replacements === 0) {
      throw new Error(
        `Cannot embed the cacheability manifest because ${CACHEABILITY_MANIFEST_DEFINE} was not found in dist/server. Rebuild the app before deploying.`,
      );
    }

    const configPath = path.relative(root, path.join(isolatedServerDirectory, "wrangler.json"));
    return upload(configPath);
  } finally {
    fs.rmSync(isolatedServerDirectory, { recursive: true, force: true });
  }
}
