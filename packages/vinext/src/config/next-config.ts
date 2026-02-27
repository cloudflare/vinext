/**
 * next.config.js / next.config.mjs / next.config.ts parser
 *
 * Loads the Next.js config file (if present) and extracts supported options.
 * Unsupported options are logged as warnings.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

export interface HasCondition {
  type: "header" | "cookie" | "query" | "host";
  key: string;
  value?: string;
}

export interface NextRedirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: HasCondition[];
  missing?: HasCondition[];
}

export interface NextRewrite {
  source: string;
  destination: string;
  has?: HasCondition[];
  missing?: HasCondition[];
}

export interface NextHeader {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

export interface NextI18nConfig {
  /** List of supported locales */
  locales: string[];
  /** The default locale (used when no locale prefix is in the URL) */
  defaultLocale: string;
  /**
   * Whether to auto-detect locale from Accept-Language header.
   * Defaults to true in Next.js.
   */
  localeDetection?: boolean;
  /**
   * Domain-based routing. Each domain maps to a specific locale.
   */
  domains?: Array<{
    domain: string;
    defaultLocale: string;
    locales?: string[];
    http?: boolean;
  }>;
}

/**
 * MDX compilation options extracted from @next/mdx config.
 * These are passed through to @mdx-js/rollup so that custom
 * remark/rehype/recma plugins configured in next.config work with Vite.
 */
export interface MdxOptions {
  remarkPlugins?: unknown[];
  rehypePlugins?: unknown[];
  recmaPlugins?: unknown[];
}

export interface NextConfig {
  /** Additional env variables */
  env?: Record<string, string>;
  /** Base URL path prefix */
  basePath?: string;
  /** Whether to add trailing slashes */
  trailingSlash?: boolean;
  /** Internationalization routing config */
  i18n?: NextI18nConfig;
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
      search?: string;
    }>;
    domains?: string[];
    unoptimized?: boolean;
    /** Allowed device widths for image optimization. Defaults to Next.js defaults: [640, 750, 828, 1080, 1200, 1920, 2048, 3840] */
    deviceSizes?: number[];
    /** Allowed image sizes for fixed-width images. Defaults to Next.js defaults: [16, 32, 48, 64, 96, 128, 256, 384] */
    imageSizes?: number[];
  };
  /** Build output mode: 'export' for full static export, 'standalone' for single server */
  output?: "export" | "standalone";
  /**
   * Enable Cache Components (Next.js 16).
   * When true, enables the "use cache" directive for pages, components, and functions.
   * Replaces the removed experimental.ppr and experimental.dynamicIO flags.
   */
  cacheComponents?: boolean;
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
  output: "" | "export" | "standalone";
  cacheComponents: boolean;
  redirects: NextRedirect[];
  rewrites: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers: NextHeader[];
  images: NextConfig["images"];
  i18n: NextI18nConfig | null;
  /** MDX remark/rehype/recma plugins extracted from @next/mdx config */
  mdx: MdxOptions | null;
  /** Extra allowed origins for server action CSRF validation (from experimental.serverActions.allowedOrigins). */
  serverActionsAllowedOrigins: string[];
}

const CONFIG_FILES = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

/**
 * Check whether an error indicates a CJS module was loaded in an ESM context
 * (i.e. the file uses `require()` which is not available in ESM).
 */
function isCjsError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  return (
    msg.includes("require is not a function") ||
    msg.includes("require is not defined") ||
    msg.includes("exports is not defined") ||
    msg.includes("module is not defined") ||
    msg.includes("__dirname is not defined") ||
    msg.includes("__filename is not defined")
  );
}

/**
 * Unwrap the config value from a loaded module, calling it if it's a
 * function-form config (Next.js supports `module.exports = (phase, opts) => config`).
 */
async function unwrapConfig(mod: any): Promise<NextConfig> {
  const config = mod.default ?? mod;
  if (typeof config === "function") {
    const result = await config("phase-development-server", {
      defaultConfig: {},
    });
    return result as NextConfig;
  }
  return config as NextConfig;
}

/**
 * Find and load the next.config file from the project root.
 * Returns null if no config file is found.
 *
 * Attempts ESM dynamic `import()` first. If the file uses CJS constructs
 * (`require`, `module.exports`) that aren't available in ESM context, falls
 * back to loading it via `createRequire` so that CJS config files (common in
 * the Next.js ecosystem for plugin wrappers like nextra, @next/mdx, etc.) work.
 */
export async function loadNextConfig(root: string): Promise<NextConfig | null> {
  for (const filename of CONFIG_FILES) {
    const configPath = path.join(root, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      // Use dynamic import for ESM/TS config files
      const fileUrl = pathToFileURL(configPath).href;
      const mod = await import(fileUrl);
      return await unwrapConfig(mod);
    } catch (e) {
      // If the error indicates a CJS file loaded in ESM context, retry with
      // createRequire which provides a proper CommonJS environment.
      if (isCjsError(e) && (filename.endsWith(".js") || filename.endsWith(".cjs"))) {
        try {
          const require = createRequire(path.join(root, "package.json"));
          const mod = require(configPath);
          return await unwrapConfig({ default: mod });
        } catch (e2) {
          console.warn(
            `[vinext] Failed to load ${filename}: ${(e2 as Error).message}`,
          );
          return null;
        }
      }

      console.warn(
        `[vinext] Failed to load ${filename}: ${(e as Error).message}`,
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
      output: "",
      cacheComponents: false,
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
      images: undefined,
      i18n: null,
      mdx: null,
      serverActionsAllowedOrigins: [],
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

  // Extract MDX remark/rehype plugins from @next/mdx's webpack wrapper
  const mdx = extractMdxOptions(config);

  // Resolve serverActions.allowedOrigins from experimental config
  const experimental = config.experimental as Record<string, unknown> | undefined;
  const serverActionsConfig = experimental?.serverActions as Record<string, unknown> | undefined;
  const serverActionsAllowedOrigins = Array.isArray(serverActionsConfig?.allowedOrigins)
    ? (serverActionsConfig.allowedOrigins as string[])
    : [];

  // Warn about unsupported options (skip webpack if we extracted MDX from it)
  const unsupported = mdx ? [] : ["webpack"];
  for (const key of unsupported) {
    if (config[key] !== undefined) {
      console.warn(
        `[vinext] next.config option "${key}" is not yet supported and will be ignored`,
      );
    }
  }

  const output = config.output ?? "";
  if (output && output !== "export" && output !== "standalone") {
    console.warn(`[vinext] Unknown output mode "${output as string}", ignoring`);
  }

  // Parse i18n config
  let i18n: NextI18nConfig | null = null;
  if (config.i18n) {
    i18n = {
      locales: config.i18n.locales,
      defaultLocale: config.i18n.defaultLocale,
      localeDetection: config.i18n.localeDetection ?? true,
      domains: config.i18n.domains,
    };
  }

  return {
    env: config.env ?? {},
    basePath: config.basePath ?? "",
    trailingSlash: config.trailingSlash ?? false,
    output: output === "export" || output === "standalone" ? output : "",
    cacheComponents: config.cacheComponents ?? false,
    redirects,
    rewrites,
    headers,
    images: config.images,
    i18n,
    mdx,
    serverActionsAllowedOrigins,
  };
}

/**
 * Extract MDX compilation options (remark/rehype/recma plugins) from
 * a Next.js config that uses @next/mdx.
 *
 * @next/mdx wraps the config with a webpack function that injects an MDX
 * loader rule. The remark/rehype plugins are captured in that closure.
 * We probe the webpack function with a mock config to extract them.
 */
export function extractMdxOptions(config: NextConfig): MdxOptions | null {
  if (typeof config.webpack !== "function") return null;

  // Build a mock webpack config object that @next/mdx's wrapper will mutate
  const mockModuleRules: any[] = [];
  const mockConfig = {
    resolve: { alias: {} as Record<string, string> },
    module: { rules: mockModuleRules },
    plugins: [] as any[],
  };
  const mockOptions = {
    defaultLoaders: { babel: { loader: "next-babel-loader" } },
    isServer: false,
    dev: false,
    dir: "/mock",
  };

  try {
    const result = (config.webpack as Function)(mockConfig, mockOptions);
    // @next/mdx may return the config or mutate in place
    const finalConfig = result ?? mockConfig;
    const rules: any[] = finalConfig.module?.rules ?? mockModuleRules;

    // Search through webpack rules for the MDX loader injected by @next/mdx
    for (const rule of rules) {
      const loaders = extractMdxLoaders(rule);
      if (loaders) return loaders;
    }
  } catch {
    // If the webpack function throws (e.g. expects real webpack internals),
    // silently skip — we'll fall back to bare mdx() with no plugins.
  }

  return null;
}

/**
 * Recursively search a webpack rule (which may have nested `oneOf` arrays)
 * for an MDX loader and extract its remark/rehype/recma plugin options.
 */
function extractMdxLoaders(rule: any): MdxOptions | null {
  if (!rule) return null;

  // Check `oneOf` arrays (Next.js uses these extensively)
  if (Array.isArray(rule.oneOf)) {
    for (const child of rule.oneOf) {
      const result = extractMdxLoaders(child);
      if (result) return result;
    }
  }

  // Check `use` array (loader chain)
  const use = Array.isArray(rule.use) ? rule.use : rule.use ? [rule.use] : [];
  for (const loader of use) {
    const loaderPath = typeof loader === "string" ? loader : loader?.loader;
    if (typeof loaderPath === "string" && isMdxLoader(loaderPath)) {
      const opts = typeof loader === "object" ? loader.options : {};
      return extractPluginsFromOptions(opts);
    }
  }

  // Check direct `loader` field
  if (typeof rule.loader === "string" && isMdxLoader(rule.loader)) {
    return extractPluginsFromOptions(rule.options);
  }

  return null;
}

function isMdxLoader(loaderPath: string): boolean {
  return (
    loaderPath.includes("mdx") &&
    (loaderPath.includes("@next") ||
     loaderPath.includes("@mdx-js") ||
     loaderPath.includes("mdx-js-loader") ||
     loaderPath.includes("next-mdx"))
  );
}

function extractPluginsFromOptions(opts: any): MdxOptions | null {
  if (!opts || typeof opts !== "object") return null;

  const remarkPlugins = Array.isArray(opts.remarkPlugins) ? opts.remarkPlugins : undefined;
  const rehypePlugins = Array.isArray(opts.rehypePlugins) ? opts.rehypePlugins : undefined;
  const recmaPlugins = Array.isArray(opts.recmaPlugins) ? opts.recmaPlugins : undefined;

  // Only return if at least one plugin array is non-empty
  if (
    (remarkPlugins && remarkPlugins.length > 0) ||
    (rehypePlugins && rehypePlugins.length > 0) ||
    (recmaPlugins && recmaPlugins.length > 0)
  ) {
    return {
      ...(remarkPlugins && remarkPlugins.length > 0 ? { remarkPlugins } : {}),
      ...(rehypePlugins && rehypePlugins.length > 0 ? { rehypePlugins } : {}),
      ...(recmaPlugins && recmaPlugins.length > 0 ? { recmaPlugins } : {}),
    };
  }

  return null;
}
