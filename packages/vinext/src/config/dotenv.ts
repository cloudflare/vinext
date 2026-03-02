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
 *
 * ## Interaction with Vite's own .env loading
 *
 * Vite also loads .env files internally during createServer()/build(). That's
 * fine — the two systems serve different purposes and don't conflict:
 *
 * - **vinext** populates `process.env` so that server-side code (SSR, API
 *   routes, Server Components) can read env vars at runtime, and so the Vite
 *   plugin's `config()` hook can scan `process.env` for `NEXT_PUBLIC_*` vars
 *   to inline via `define`.
 *
 * - **Vite** loads .env files to populate `import.meta.env.VITE_*` for its
 *   own client exposure mechanism (which Next.js apps don't use).
 *
 * Because we load first and neither system overwrites existing keys, Vite's
 * pass is effectively a no-op for overlapping keys. For `start` and `deploy`
 * commands (which don't go through Vite at all), this is the only loading.
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
    const parsed = parseEnv(fileContent) as Record<string, string>;
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
    let value = raw.replace(ENV_REF_RE, (match, escaped, braced, bare) => {
      if (escaped) return match.slice(1);

      const refKey = (braced || bare) as string;
      return resolveValue(refKey);
    });
    // Strip remaining \$ escapes not caught by the regex (e.g. \$100 where
    // what follows $ isn't a valid variable name).
    value = value.replace(/\\\$/g, "$");
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
