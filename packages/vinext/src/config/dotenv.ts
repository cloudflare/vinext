import fs from "node:fs";
import path from "pathslash";
import { parseEnv } from "node:util";

/**
 * Environment-variable bag accepted by {@link loadDotenv}.
 *
 * Intentionally a plain string→string|undefined dictionary rather than
 * `NodeJS.ProcessEnv`. `NodeJS.ProcessEnv` is augmented by `@types/node` (and
 * by Next.js, when it's anywhere in the workspace) to make `NODE_ENV` a
 * required, readonly property, which doesn't reflect Node's real runtime
 * behaviour and breaks tests that pass throwaway dictionaries here.
 */
type EnvBag = Record<string, string | undefined>;

type LoadDotenvOptions = {
  root: string;
  mode: string;
  processEnv?: EnvBag;
};

type LoadDotenvResult = {
  mode: string;
  loadedFiles: string[];
  loadedEnv: Record<string, string>;
};

/**
 * Next.js-compatible dotenv lookup order (highest priority first).
 */
export function getDotenvFiles(mode: string): string[] {
  return [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"];
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

function expandEnv(parsed: Record<string, string>, processEnv: EnvBag): Record<string, string> {
  const expanded = { ...parsed };
  for (const key of Object.keys(expanded)) {
    const processValue = processEnv[key];
    const value =
      processValue && processValue !== expanded[key]
        ? processValue
        : expandValue(expanded[key], processEnv, expanded);
    expanded[key] = value.replace(/\\\$/g, "$");
  }
  return expanded;
}

function expandValue(value: string, processEnv: EnvBag, parsed: Record<string, string>): string {
  const env: EnvBag = { ...parsed, ...processEnv };
  const envRefRe = /(?<!\\)\${([^{}]+)}|(?<!\\)\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const seen = new Set<string>();
  let result = value;
  let match: RegExpExecArray | null;

  while ((match = envRefRe.exec(result)) !== null) {
    seen.add(result);
    const [template, braced, bare] = match;
    const expression = (braced || bare) as string;
    const operator = expression.match(/(:\+|\+|:-|-)/)?.[0];
    const parts = operator ? expression.split(operator) : [expression];
    const refKey = parts.shift() as string;
    const operand = parts.join(operator ?? "");
    const refValue = env[refKey];

    let replacement: string;
    if (operator === ":+" || operator === "+") {
      replacement = refValue ? operand : "";
    } else if (refValue) {
      replacement = seen.has(refValue) ? operand : refValue;
    } else {
      replacement = operand;
    }

    result = result.replace(template, replacement);
    if (result === parsed[refKey]) break;
    envRefRe.lastIndex = 0;
  }

  return result;
}
