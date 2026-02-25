import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export type VinextEnvMode = "development" | "production" | "test";

export interface LoadDotenvOptions {
  root: string;
  mode: VinextEnvMode;
  processEnv?: NodeJS.ProcessEnv;
}

export interface LoadDotenvResult {
  mode: VinextEnvMode;
  loadedFiles: string[];
  loadedEnv: Record<string, string>;
}

/**
 * Next.js-compatible dotenv lookup order (highest priority first).
 */
export function getDotenvFiles(mode: VinextEnvMode): string[] {
  return [
    `.env.${mode}.local`,
    ...(mode === "test" ? [] : [".env.local"]),
    `.env.${mode}`,
    ".env",
  ];
}

/**
 * Load .env files into processEnv with Next.js-like precedence:
 * process.env > .env.<mode>.local > .env.local > .env.<mode> > .env.
 *
 * This mutates processEnv (defaults to process.env).
 */
export function loadDotenv({
  root,
  mode,
  processEnv = process.env,
}: LoadDotenvOptions): LoadDotenvResult {
  const loadedFiles: string[] = [];
  const loadedEnv: Record<string, string> = {};

  for (const relativeFile of getDotenvFiles(mode)) {
    const filePath = path.join(root, relativeFile);
    if (!fs.existsSync(filePath)) continue;

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const parsed = parseEnv(fileContent);
    const expanded = expandEnv(parsed, processEnv);

    for (const [key, value] of Object.entries(expanded)) {
      if (processEnv[key] !== undefined) continue;
      processEnv[key] = value;
      loadedEnv[key] = value;
    }

    loadedFiles.push(relativeFile);
  }

  return {
    mode,
    loadedFiles,
    loadedEnv,
  };
}

const ENV_REF_RE = /(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function expandEnv(
  parsed: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const expanded: Record<string, string> = {};
  const resolving = new Set<string>();
  const context: Record<string, string | undefined> = {
    ...parsed,
    ...processEnv,
  };

  function resolveValue(key: string): string {
    const cached = expanded[key];
    if (cached !== undefined) return cached;

    if (resolving.has(key)) {
      return context[key] ?? "";
    }

    const raw = context[key];
    if (raw === undefined) return "";

    resolving.add(key);
    const value = raw.replace(ENV_REF_RE, (match, escaped, braced, bare) => {
      if (escaped) return match.slice(1);

      const refKey = (braced || bare) as string;
      return resolveValue(refKey);
    });
    resolving.delete(key);

    expanded[key] = value;
    context[key] = value;
    return value;
  }

  for (const key of Object.keys(parsed)) {
    resolveValue(key);
  }

  return expanded;
}
