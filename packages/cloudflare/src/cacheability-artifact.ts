import fs from "node:fs";
import path from "node:path";
import { CACHEABILITY_MANIFEST_PLACEHOLDER } from "vinext/internal/server/cacheability-manifest";
import type { CacheabilityManifest } from "vinext/internal/server/cacheability-manifest";

const EMBEDDED_CACHEABILITY_MODULE = "__vinext_cacheability_manifest.js";
const EMBEDDED_CACHEABILITY_IDENTIFIER = "__vinextCacheabilityManifest_7a4d2d86";

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
 * identifier with imports of one generated module avoids a second application
 * build and avoids duplicating a potentially large manifest in every router
 * bundle. Keeping the reusable build immutable also makes a failed or
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
  // fs.cp rejects a directory-to-descendant copy before its filter runs. A
  // config at dist/wrangler.json therefore needs a sibling temporary tree;
  // nested dist/server configs can stay under dist as before.
  const isolatedParent = serverDirectory === distDirectory ? root : distDirectory;
  const isolatedServerDirectory = fs.mkdtempSync(
    path.join(isolatedParent, ".vinext-cacheability-"),
  );
  const placeholderLiterals = [
    JSON.stringify(CACHEABILITY_MANIFEST_PLACEHOLDER),
    `'${CACHEABILITY_MANIFEST_PLACEHOLDER}'`,
    `\`${CACHEABILITY_MANIFEST_PLACEHOLDER}\``,
  ];
  const replacement = EMBEDDED_CACHEABILITY_IDENTIFIER;
  let replacements = 0;

  try {
    fs.cpSync(serverDirectory, isolatedServerDirectory, { recursive: true });
    const serverArtifacts = collectServerJavaScript(isolatedServerDirectory);
    for (const filePath of serverArtifacts) {
      const content = fs.readFileSync(filePath, "utf-8");
      const presentLiterals = placeholderLiterals.filter((literal) => content.includes(literal));
      if (presentLiterals.length === 0) continue;
      replacements += 1;
      const relativeModulePath = path
        .relative(
          path.dirname(filePath),
          path.join(isolatedServerDirectory, EMBEDDED_CACHEABILITY_MODULE),
        )
        .split(path.sep)
        .join("/");
      const moduleSpecifier = relativeModulePath.startsWith(".")
        ? relativeModulePath
        : `./${relativeModulePath}`;
      const importStatement = `import ${EMBEDDED_CACHEABILITY_IDENTIFIER} from ${JSON.stringify(moduleSpecifier)};\n`;
      const replaced = presentLiterals.reduce(
        (embedded, literal) => embedded.replaceAll(literal, replacement),
        content,
      );
      const embedded = replaced.startsWith("#!")
        ? replaced.replace("\n", `\n${importStatement}`)
        : importStatement + replaced;
      fs.writeFileSync(filePath, embedded);
    }

    if (replacements === 0) {
      throw new Error(
        "Cannot embed the cacheability manifest because its placeholder was not found in dist/server. Rebuild the app before deploying.",
      );
    }

    // All router environments import one attached module instead of each
    // embedding the full manifest. This is especially important for large
    // generateStaticParams/getStaticPaths sets: Wrangler uploads the module
    // once and V8 parses one JSON payload rather than one copy per bundle.
    fs.writeFileSync(
      path.join(isolatedServerDirectory, EMBEDDED_CACHEABILITY_MODULE),
      `export default ${JSON.stringify(JSON.stringify(manifest))};\n`,
    );

    const isolatedConfigPath = path.relative(
      root,
      path.join(isolatedServerDirectory, path.basename(configPath)),
    );
    return upload(isolatedConfigPath);
  } finally {
    fs.rmSync(isolatedServerDirectory, { recursive: true, force: true });
  }
}
