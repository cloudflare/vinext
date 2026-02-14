/**
 * next.config.js / next.config.mjs / next.config.ts parser
 *
 * Loads the Next.js config file (if present) and extracts supported options.
 * Unsupported options are logged as warnings.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

export interface NextRedirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: Array<{
    type: "header" | "cookie" | "query" | "host";
    key: string;
    value?: string;
  }>;
}

export interface NextRewrite {
  source: string;
  destination: string;
  has?: Array<{
    type: "header" | "cookie" | "query" | "host";
    key: string;
    value?: string;
  }>;
}

export interface NextHeader {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

export interface NextConfig {
  /** Additional env variables */
  env?: Record<string, string>;
  /** Base URL path prefix */
  basePath?: string;
  /** Whether to add trailing slashes */
  trailingSlash?: boolean;
  /** URL redirect rules */
  redirects?: () => Promise<NextRedirect[]> | NextRedirect[];
  /** URL rewrite rules */
  rewrites?: () =>
    | Promise<NextRewrite[] | { beforeFiles: NextRewrite[]; afterFiles: NextRewrite[]; fallback: NextRewrite[] }>
    | NextRewrite[]
    | { beforeFiles: NextRewrite[]; afterFiles: NextRewrite[]; fallback: NextRewrite[] };
  /** Custom response headers */
  headers?: () => Promise<NextHeader[]> | NextHeader[];
  /** Image optimization config */
  images?: {
    remotePatterns?: Array<{
      protocol?: string;
      hostname: string;
      port?: string;
      pathname?: string;
    }>;
    domains?: string[];
    unoptimized?: boolean;
  };
  /** Transpile packages (Vite handles this natively) */
  transpilePackages?: string[];
  /** Webpack config (ignored — we use Vite) */
  webpack?: unknown;
  /** Any other options */
  [key: string]: unknown;
}

/**
 * Resolved configuration with all async values awaited.
 */
export interface ResolvedNextConfig {
  env: Record<string, string>;
  basePath: string;
  trailingSlash: boolean;
  redirects: NextRedirect[];
  rewrites: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers: NextHeader[];
  images: NextConfig["images"];
}

const CONFIG_FILES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

/**
 * Find and load the next.config file from the project root.
 * Returns null if no config file is found.
 */
export async function loadNextConfig(root: string): Promise<NextConfig | null> {
  for (const filename of CONFIG_FILES) {
    const configPath = path.join(root, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      // Use dynamic import for ESM/TS config files
      const fileUrl = pathToFileURL(configPath).href;
      const mod = await import(fileUrl);
      const config = mod.default ?? mod;

      // next.config can be a function that returns the config
      if (typeof config === "function") {
        const result = await config("phase-development-server", {
          defaultConfig: {},
        });
        return result as NextConfig;
      }

      return config as NextConfig;
    } catch (e) {
      console.warn(
        `[nextcompat] Failed to load ${filename}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  return null;
}

/**
 * Resolve a NextConfig into a fully-resolved ResolvedNextConfig.
 * Awaits async functions for redirects/rewrites/headers.
 */
export async function resolveNextConfig(
  config: NextConfig | null,
): Promise<ResolvedNextConfig> {
  if (!config) {
    return {
      env: {},
      basePath: "",
      trailingSlash: false,
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
      images: undefined,
    };
  }

  // Resolve redirects
  let redirects: NextRedirect[] = [];
  if (config.redirects) {
    const result = await config.redirects();
    redirects = Array.isArray(result) ? result : [];
  }

  // Resolve rewrites
  let rewrites = { beforeFiles: [] as NextRewrite[], afterFiles: [] as NextRewrite[], fallback: [] as NextRewrite[] };
  if (config.rewrites) {
    const result = await config.rewrites();
    if (Array.isArray(result)) {
      rewrites.afterFiles = result;
    } else {
      rewrites = {
        beforeFiles: result.beforeFiles ?? [],
        afterFiles: result.afterFiles ?? [],
        fallback: result.fallback ?? [],
      };
    }
  }

  // Resolve headers
  let headers: NextHeader[] = [];
  if (config.headers) {
    headers = await config.headers();
  }

  // Warn about unsupported options
  const unsupported = ["webpack", "experimental", "i18n", "output"];
  for (const key of unsupported) {
    if (config[key] !== undefined) {
      console.warn(
        `[nextcompat] next.config option "${key}" is not yet supported and will be ignored`,
      );
    }
  }

  return {
    env: config.env ?? {},
    basePath: config.basePath ?? "",
    trailingSlash: config.trailingSlash ?? false,
    redirects,
    rewrites,
    headers,
    images: config.images,
  };
}
