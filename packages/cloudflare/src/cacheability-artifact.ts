import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
  CACHEABILITY_MANIFEST_MODULE,
  type CacheabilityManifest,
} from "vinext/internal/server/cacheability-manifest";
import {
  cacheabilityManifestByteLimitError,
  MAX_CACHEABILITY_MANIFEST_BYTES,
} from "./cacheability-manifest-limits.js";

type JavaScriptToken = {
  kind: "identifier" | "punctuator" | "string";
  value: string;
};

function tokenizeStaticImports(source: string): JavaScriptToken[] {
  const tokens: JavaScriptToken[] = [];
  let index = 0;

  const canStartRegularExpression = (): boolean => {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.kind === "punctuator" && "({[=,:;!?&|+-*%^~<>".includes(previous.value)) {
      return true;
    }
    return (
      previous.kind === "identifier" &&
      /^(?:await|case|delete|do|else|in|instanceof|of|return|throw|typeof|void|yield)$/.test(
        previous.value,
      )
    );
  };

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === "/" && canStartRegularExpression()) {
      let inCharacterClass = false;
      index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "[") inCharacterClass = true;
        if (source[index] === "]") inCharacterClass = false;
        if (source[index++] === "/" && !inCharacterClass) break;
      }
      while (index < source.length && /[A-Za-z]/.test(source[index])) index++;
      continue;
    }
    if (character === "`") {
      index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index++] === "`") {
          break;
        }
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = ++index;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === "\\" ? 2 : 1;
      }
      tokens.push({ kind: "string", value: source.slice(start, index) });
      index++;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[\w$]/.test(source[index])) index++;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuator", value: character });
    index++;
  }

  return tokens;
}

/**
 * Check only the generated entry module's static dependency declarations. This
 * deliberately avoids an AST parse or module-graph walk on the deploy path,
 * while rejecting comments, strings, templates, and dynamic imports that only
 * happen to mention the manifest filename.
 */
function hasStaticModuleSpecifier(source: string, expected: string): boolean {
  const tokens = tokenizeStaticImports(source);
  let braceDepth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === "{") {
      braceDepth++;
      continue;
    }
    if (token.value === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth !== 0 || token.kind !== "identifier") continue;

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.kind === "string" && next.value === expected) return true;
      if (next?.value === "(" || next?.value === ".") continue;
    } else if (token.value !== "export") {
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const candidate = tokens[cursor];
      if (candidate.value === ";") break;
      if (candidate.kind === "identifier" && candidate.value === "from") {
        const specifier = tokens[cursor + 1];
        if (specifier?.kind === "string" && specifier.value === expected) return true;
        break;
      }
    }
  }
  return false;
}

function resolveGeneratedServerConfig(root: string, configuredPath: string | undefined): string {
  const distDirectory = path.join(root, "dist");
  const configPath = path.resolve(root, configuredPath ?? "dist/server/wrangler.json");
  const relativeConfigPath = path.relative(distDirectory, configPath);
  if (relativeConfigPath.startsWith("..") || path.isAbsolute(relativeConfigPath)) {
    throw new Error(
      "Two-stage CDN warming requires a generated Wrangler config under dist/. Pass --config dist/server/wrangler.json (or another generated dist config).",
    );
  }
  if (!fs.existsSync(configPath) || !fs.lstatSync(configPath).isFile()) {
    throw new Error(
      `Two-stage CDN warming requires the generated Wrangler config at ${path.relative(root, configPath)}. Rebuild the app before deploying.`,
    );
  }
  return configPath;
}

function assertManifestModuleReachable(configPath: string): void {
  const serverDirectory = path.dirname(configPath);
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (cause) {
    throw new Error("Two-stage CDN warming could not parse the generated Wrangler config.", {
      cause,
    });
  }
  const main =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).main
      : undefined;
  if (typeof main !== "string" || main.length === 0) {
    throw new Error("Two-stage CDN warming requires a generated Wrangler main module.");
  }
  const mainPath = path.resolve(serverDirectory, main);
  if (!fs.existsSync(mainPath) || !fs.lstatSync(mainPath).isFile()) {
    throw new Error("Two-stage CDN warming could not find the generated Wrangler main module.");
  }
  if (
    !hasStaticModuleSpecifier(
      fs.readFileSync(mainPath, "utf8"),
      `./${CACHEABILITY_MANIFEST_MODULE}`,
    )
  ) {
    throw new Error(
      `Two-stage CDN warming requires the generated Worker main module to import ${CACHEABILITY_MANIFEST_MODULE}.`,
    );
  }
}

/**
 * Write the version-specific manifest into the built Worker artifact.
 * The application build already imports this stable module asset, so the
 * completed dist directory remains the exact input to the final upload.
 */
export function writeCacheabilityManifestArtifact(
  root: string,
  configuredPath: string | undefined,
  manifest: CacheabilityManifest,
): string {
  const configPath = resolveGeneratedServerConfig(root, configuredPath);
  assertManifestModuleReachable(configPath);
  const serverDirectory = path.dirname(configPath);
  const manifestPath = path.join(serverDirectory, CACHEABILITY_MANIFEST_MODULE);
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    throw new Error(
      `Two-stage CDN warming requires ${CACHEABILITY_MANIFEST_MODULE} in the generated Worker artifact. Rebuild the app before deploying.`,
    );
  }
  const serializedManifest = JSON.stringify(manifest);
  const manifestBytes = Buffer.byteLength(serializedManifest);
  if (manifestBytes > MAX_CACHEABILITY_MANIFEST_BYTES) {
    throw cacheabilityManifestByteLimitError(manifestBytes);
  }

  const manifestSource = `export default ${JSON.stringify(serializedManifest)};\n`;
  const pendingManifestPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(pendingManifestPath, manifestSource, "utf8");
    fs.renameSync(pendingManifestPath, manifestPath);
  } finally {
    if (fs.existsSync(pendingManifestPath)) fs.unlinkSync(pendingManifestPath);
  }
  return path.relative(root, configPath);
}
