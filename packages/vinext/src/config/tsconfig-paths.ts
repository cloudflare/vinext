/**
 * tsconfig.json `compilerOptions.paths` loader.
 *
 * Used to make tsconfig path aliases (e.g. `@/foo` mapping to `./src/foo`)
 * available when vinext loads `next.config.ts` through Vite's `runnerImport`.
 *
 * Next.js's own `next.config.ts` loader (packages/next/src/build/next-config-ts/
 * transpile-config.ts) reads `compilerOptions.paths` from the project's
 * `tsconfig.json` and passes them to SWC so that imports like
 * `import { foo } from '@/foo'` resolve at config load time. We do the same
 * here, but as Vite `resolve.alias` entries.
 *
 * The implementation is intentionally minimal:
 *   - Static JSON-style parse of tsconfig.json (handles trailing commas /
 *     comments via the shared `parseStaticObjectLiteral` helper)
 *   - `extends` is followed up to a small recursion depth, with cycle
 *     detection — matches the subset Next.js supports
 *   - Only the common `"@/*": ["./src/*"]` / `"@/*": ["src/*"]` pattern is
 *     supported; non-wildcard paths and exact aliases also work
 *   - Returned alias values are always absolute paths so they work with
 *     `runnerImport`'s inline environment (which has its own root).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseStaticObjectLiteral } from "../plugins/fonts.js";

const TSCONFIG_FILES = ["tsconfig.json", "jsconfig.json"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveTsconfigPathCandidate(candidate: string): string | null {
  const candidates = candidate.endsWith(".json")
    ? [candidate]
    : [candidate, `${candidate}.json`, path.join(candidate, "tsconfig.json")];

  for (const item of candidates) {
    if (fs.existsSync(item) && fs.statSync(item).isFile()) {
      return item;
    }
  }

  return null;
}

function resolveTsconfigExtends(configPath: string, specifier: string): string | null {
  const fromDir = path.dirname(configPath);
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    return resolveTsconfigPathCandidate(path.resolve(fromDir, specifier));
  }

  const requireFromConfig = createRequire(configPath);
  const candidates = [specifier, `${specifier}.json`, path.join(specifier, "tsconfig.json")];

  for (const item of candidates) {
    try {
      return requireFromConfig.resolve(item);
    } catch {}
  }

  return null;
}

function materializeAliases(
  pathsConfig: Record<string, unknown>,
  baseUrl: string,
): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const [find, rawTargets] of Object.entries(pathsConfig)) {
    const target = Array.isArray(rawTargets)
      ? rawTargets.find((value): value is string => typeof value === "string")
      : typeof rawTargets === "string"
        ? rawTargets
        : null;
    if (!target) continue;

    if (find.includes("*") || target.includes("*")) {
      // Only support trailing wildcard (the common `"@/*": ["./src/*"]` form).
      if (!find.endsWith("/*") || !target.endsWith("/*")) continue;
      if (find.indexOf("*") !== find.length - 1 || target.indexOf("*") !== target.length - 1) {
        continue;
      }

      const aliasKey = find.slice(0, -2);
      const targetDir = target.slice(0, -2);
      if (!aliasKey || !targetDir) continue;

      aliases[aliasKey] = path.resolve(baseUrl, targetDir);
      continue;
    }

    aliases[find] = path.resolve(baseUrl, target);
  }

  return aliases;
}

function loadAliasesFromTsconfigFile(
  configPath: string,
  seen: Set<string>,
): Record<string, string> {
  if (seen.has(configPath)) return {};
  seen.add(configPath);

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseStaticObjectLiteral(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
  if (!parsed) return {};

  let aliases: Record<string, string> = {};
  if (typeof parsed.extends === "string") {
    const extendedPath = resolveTsconfigExtends(configPath, parsed.extends);
    if (extendedPath) {
      aliases = loadAliasesFromTsconfigFile(extendedPath, seen);
    }
  }

  const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : null;
  const pathsConfig =
    compilerOptions && isRecord(compilerOptions.paths) ? compilerOptions.paths : null;
  if (!pathsConfig) return aliases;

  const baseUrl =
    compilerOptions && typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const resolvedBaseUrl = path.resolve(path.dirname(configPath), baseUrl);

  return {
    ...aliases,
    ...materializeAliases(pathsConfig, resolvedBaseUrl),
  };
}

/**
 * Read the project's tsconfig.json (or jsconfig.json) and return its
 * `compilerOptions.paths` as absolute-path Vite `resolve.alias` entries.
 *
 * Returns an empty object if no config is found or no paths are configured.
 * Errors during parsing are swallowed — this is a best-effort helper that
 * must not break config loading.
 */
export function loadTsconfigPathAliasesForRoot(projectRoot: string): Record<string, string> {
  for (const name of TSCONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (!fs.existsSync(candidate)) continue;
    return loadAliasesFromTsconfigFile(candidate, new Set());
  }
  return {};
}
