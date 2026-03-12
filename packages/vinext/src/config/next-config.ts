/**
 * next.config.js / next.config.mjs / next.config.ts parser
 *
 * Loads the Next.js config file (if present) and extracts supported options.
 * Unsupported options are logged as warnings.
 */
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PHASE_DEVELOPMENT_SERVER } from "../shims/constants.js";
import { normalizePageExtensions } from "../routing/file-matcher.js";
import { isExternalUrl } from "./config-matchers.js";

/**
 * Parse a body size limit value (string or number) into bytes.
 * Accepts Next.js-style strings like "1mb", "500kb", "10mb", bare number strings like "1048576" (bytes),
 * and numeric values. Supports b, kb, mb, gb, tb, pb units.
 * Returns the default 1MB if the value is not provided or invalid.
 * Throws if the parsed value is less than 1.
 */
export function parseBodySizeLimit(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 1 * 1024 * 1024;
  if (typeof value === "number") {
    if (value < 1) throw new Error(`Body size limit must be a positive number, got ${value}`);
    return value;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i);
  if (!match) {
    console.warn(
      `[vinext] Invalid bodySizeLimit value: "${value}". Expected a number or a string like "1mb", "500kb". Falling back to 1MB.`,
    );
    return 1 * 1024 * 1024;
  }
  const num = parseFloat(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  let bytes: number;
  switch (unit) {
    case "b":
      bytes = Math.floor(num);
      break;
    case "kb":
      bytes = Math.floor(num * 1024);
      break;
    case "mb":
      bytes = Math.floor(num * 1024 * 1024);
      break;
    case "gb":
      bytes = Math.floor(num * 1024 * 1024 * 1024);
      break;
    case "tb":
      bytes = Math.floor(num * 1024 * 1024 * 1024 * 1024);
      break;
    case "pb":
      bytes = Math.floor(num * 1024 * 1024 * 1024 * 1024 * 1024);
      break;
    default:
      return 1 * 1024 * 1024;
  }
  if (bytes < 1) throw new Error(`Body size limit must be a positive number, got ${bytes}`);
  return bytes;
}

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
  has?: HasCondition[];
  missing?: HasCondition[];
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
    | Promise<
        | NextRewrite[]
        | {
            beforeFiles: NextRewrite[];
            afterFiles: NextRewrite[];
            fallback: NextRewrite[];
          }
      >
    | NextRewrite[]
    | {
        beforeFiles: NextRewrite[];
        afterFiles: NextRewrite[];
        fallback: NextRewrite[];
      };
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
    /** Allow SVG images through the image optimization endpoint. SVG can contain scripts, so only enable if you trust all image sources. */
    dangerouslyAllowSVG?: boolean;
    /** Content-Disposition header for image responses. Defaults to "inline". */
    contentDispositionType?: "inline" | "attachment";
    /** Content-Security-Policy header for image responses. Defaults to "script-src 'none'; frame-src 'none'; sandbox;" */
    contentSecurityPolicy?: string;
  };
  /** Build output mode: 'export' for full static export, 'standalone' for single server */
  output?: "export" | "standalone";
  /** File extensions treated as routable pages/routes (Next.js pageExtensions) */
  pageExtensions?: string[];
  /** Extra origins allowed to access the dev server. */
  allowedDevOrigins?: string[];
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
  /**
   * Custom build ID generator. If provided, called once at build/dev start.
   * Must return a non-empty string, or null to use the default random ID.
   */
  generateBuildId?: () => string | null | Promise<string | null>;
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
  pageExtensions: string[];
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
  /** Explicit module aliases preserved from wrapped next.config plugins. */
  aliases: Record<string, string>;
  /** Extra allowed origins for dev server access (from allowedDevOrigins). */
  allowedDevOrigins: string[];
  /** Extra allowed origins for server action CSRF validation (from experimental.serverActions.allowedOrigins). */
  serverActionsAllowedOrigins: string[];
  /** Parsed body size limit for server actions in bytes (from experimental.serverActions.bodySizeLimit). Defaults to 1MB. */
  serverActionsBodySizeLimit: number;
  /** Resolved build ID (from generateBuildId, or a random UUID if not provided). */
  buildId: string;
}

const CONFIG_FILES = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

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
 * Emit a warning when config loading fails, with a targeted hint for
 * known plugin wrappers that are unnecessary in vinext.
 */
function warnConfigLoadFailure(filename: string, err: Error): void {
  const msg = err.message ?? "";
  const stack = err.stack ?? "";
  const isNextIntlPlugin =
    msg.includes("next-intl") ||
    stack.includes("next-intl/plugin") ||
    stack.includes("next-intl/dist");

  console.warn(`[vinext] Failed to load ${filename}: ${msg}`);
  if (isNextIntlPlugin) {
    console.warn(
      "[vinext] Hint: createNextIntlPlugin() is not needed with vinext. " +
        "Remove the next-intl/plugin wrapper from your next.config — " +
        "vinext auto-detects next-intl and registers the i18n config alias automatically.",
    );
  }
}

/**
 * Unwrap the config value from a loaded module, calling it if it's a
 * function-form config (Next.js supports `module.exports = (phase, opts) => config`).
 */
async function unwrapConfig(
  mod: any,
  phase: string = PHASE_DEVELOPMENT_SERVER,
): Promise<NextConfig> {
  const config = mod.default ?? mod;
  if (typeof config === "function") {
    const result = await config(phase, {
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
 * Attempts Vite's module runner first so TS configs and extensionless local
 * imports (e.g. `import "./env"`) resolve consistently. If loading fails due
 * to CJS constructs (`require`, `module.exports`), falls back to `createRequire`
 * so common CJS plugin wrappers (nextra, @next/mdx, etc.) still work.
 */
export async function loadNextConfig(
  root: string,
  phase: string = PHASE_DEVELOPMENT_SERVER,
): Promise<NextConfig | null> {
  for (const filename of CONFIG_FILES) {
    const configPath = path.join(root, filename);
    if (!fs.existsSync(configPath)) continue;

    try {
      // Load config via Vite's module runner (TS + extensionless import support)
      const { runnerImport } = await import("vite");
      const { module: mod } = await runnerImport(configPath, {
        root,
        logLevel: "error",
        clearScreen: false,
      });
      return await unwrapConfig(mod, phase);
    } catch (e) {
      // If the error indicates a CJS file loaded in ESM context, retry with
      // createRequire which provides a proper CommonJS environment.
      if (isCjsError(e) && (filename.endsWith(".js") || filename.endsWith(".cjs"))) {
        try {
          const require = createRequire(path.join(root, "package.json"));
          const mod = require(configPath);
          return await unwrapConfig({ default: mod }, phase);
        } catch (e2) {
          warnConfigLoadFailure(filename, e2 as Error);
          return null;
        }
      }

      warnConfigLoadFailure(filename, e as Error);
      return null;
    }
  }

  return null;
}

/**
 * Generate a UUID that doesn't contain "ad" to avoid false-positive ad-blocker hits.
 * Mirrors Next.js's own nanoid retry loop.
 */
function safeUUID(): string {
  let id = randomUUID();
  while (/ad/i.test(id)) id = randomUUID();
  return id;
}

/**
 * Call the user's generateBuildId function and validate its return value.
 * Follows Next.js semantics: null return falls back to a random UUID; any
 * other non-string throws. Leading/trailing whitespace is trimmed.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId
 */
async function resolveBuildId(
  generate: (() => string | null | Promise<string | null>) | undefined,
): Promise<string> {
  if (!generate) return safeUUID();

  const result = await generate();

  if (result === null) return safeUUID();

  if (typeof result !== "string") {
    throw new Error(
      "generateBuildId did not return a string. https://nextjs.org/docs/messages/generatebuildid-not-a-string",
    );
  }

  const trimmed = result.trim();
  if (trimmed.length === 0) {
    throw new Error(
      "generateBuildId returned an empty string. https://nextjs.org/docs/messages/generatebuildid-not-a-string",
    );
  }

  return trimmed;
}

/**
 * Resolve a NextConfig into a fully-resolved ResolvedNextConfig.
 * Awaits async functions for redirects/rewrites/headers.
 */
export async function resolveNextConfig(
  config: NextConfig | null,
  root: string = process.cwd(),
): Promise<ResolvedNextConfig> {
  if (!config) {
    const buildId = await resolveBuildId(undefined);
    const resolved: ResolvedNextConfig = {
      env: {},
      basePath: "",
      trailingSlash: false,
      output: "",
      pageExtensions: normalizePageExtensions(),
      cacheComponents: false,
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
      images: undefined,
      i18n: null,
      mdx: null,
      aliases: {},
      allowedDevOrigins: [],
      serverActionsAllowedOrigins: [],
      serverActionsBodySizeLimit: 1 * 1024 * 1024,
      buildId,
    };
    detectNextIntlConfig(root, resolved);
    return resolved;
  }

  // Resolve redirects
  let redirects: NextRedirect[] = [];
  if (config.redirects) {
    const result = await config.redirects();
    redirects = Array.isArray(result) ? result : [];
  }

  // Resolve rewrites
  let rewrites = {
    beforeFiles: [] as NextRewrite[],
    afterFiles: [] as NextRewrite[],
    fallback: [] as NextRewrite[],
  };
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

  {
    const allRewrites = [...rewrites.beforeFiles, ...rewrites.afterFiles, ...rewrites.fallback];
    const externalRewrites = allRewrites.filter((rewrite) => isExternalUrl(rewrite.destination));

    if (externalRewrites.length > 0) {
      const noun = externalRewrites.length === 1 ? "external rewrite" : "external rewrites";
      const listing = externalRewrites
        .map((rewrite) => `  ${rewrite.source} → ${rewrite.destination}`)
        .join("\n");

      console.warn(
        `[vinext] Found ${externalRewrites.length} ${noun} that proxy requests to external origins:\n` +
          `${listing}\n` +
          `Request headers, including credential headers (cookie, authorization, proxy-authorization, x-api-key), ` +
          `are forwarded to the external origin to match Next.js behavior. ` +
          `If you do not want to forward credentials, use an API route or route handler where you control exactly which headers are sent.`,
      );
    }
  }

  // Resolve headers
  let headers: NextHeader[] = [];
  if (config.headers) {
    headers = await config.headers();
  }

  // Probe wrapped webpack config once so alias extraction and MDX extraction
  // observe the same mock environment.
  const webpackProbe = await probeWebpackConfig(config, root);
  const mdx = webpackProbe.mdx;
  const aliases = {
    ...extractTurboAliases(config, root),
    ...webpackProbe.aliases,
  };

  const allowedDevOrigins = Array.isArray(config.allowedDevOrigins) ? config.allowedDevOrigins : [];

  // Resolve serverActions.allowedOrigins and bodySizeLimit from experimental config
  const experimental = config.experimental as Record<string, unknown> | undefined;
  const serverActionsConfig = experimental?.serverActions as Record<string, unknown> | undefined;
  const serverActionsAllowedOrigins = Array.isArray(serverActionsConfig?.allowedOrigins)
    ? (serverActionsConfig.allowedOrigins as string[])
    : [];
  const serverActionsBodySizeLimit = parseBodySizeLimit(
    serverActionsConfig?.bodySizeLimit as string | number | undefined,
  );

  // Warn about unsupported webpack usage. We preserve alias injection and
  // extract MDX settings, but all other webpack customization is still ignored.
  if (config.webpack !== undefined) {
    if (mdx || Object.keys(webpackProbe.aliases).length > 0) {
      console.warn(
        '[vinext] next.config option "webpack" is only partially supported. ' +
          "vinext preserves resolve.alias entries and MDX loader settings, but other webpack customization is ignored",
      );
    } else {
      console.warn(
        '[vinext] next.config option "webpack" is not yet supported and will be ignored',
      );
    }
  }

  const output = config.output ?? "";
  if (output && output !== "export" && output !== "standalone") {
    console.warn(`[vinext] Unknown output mode "${output as string}", ignoring`);
  }

  const pageExtensions = normalizePageExtensions(config.pageExtensions);

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

  const buildId = await resolveBuildId(
    config.generateBuildId as (() => string | null | Promise<string | null>) | undefined,
  );

  const resolved: ResolvedNextConfig = {
    env: config.env ?? {},
    basePath: config.basePath ?? "",
    trailingSlash: config.trailingSlash ?? false,
    output: output === "export" || output === "standalone" ? output : "",
    pageExtensions,
    cacheComponents: config.cacheComponents ?? false,
    redirects,
    rewrites,
    headers,
    images: config.images,
    i18n,
    mdx,
    aliases,
    allowedDevOrigins,
    serverActionsAllowedOrigins,
    serverActionsBodySizeLimit,
    buildId,
  };

  // Auto-detect next-intl (lowest priority — explicit aliases from
  // webpack/turbopack already in `aliases` take precedence)
  detectNextIntlConfig(root, resolved);

  return resolved;
}

function normalizeAliasEntries(
  aliases: Record<string, unknown> | undefined,
  root: string,
): Record<string, string> {
  if (!aliases) return {};

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof value !== "string") continue;
    normalized[key] = path.isAbsolute(value) ? value : path.resolve(root, value);
  }
  return normalized;
}

function extractTurboAliases(config: NextConfig, root: string): Record<string, string> {
  const experimental = config.experimental as Record<string, unknown> | undefined;
  const experimentalTurbo = experimental?.turbo as Record<string, unknown> | undefined;
  const topLevelTurbopack = config.turbopack as Record<string, unknown> | undefined;

  return {
    ...normalizeAliasEntries(
      experimentalTurbo?.resolveAlias as Record<string, unknown> | undefined,
      root,
    ),
    ...normalizeAliasEntries(
      topLevelTurbopack?.resolveAlias as Record<string, unknown> | undefined,
      root,
    ),
  };
}

async function probeWebpackConfig(
  config: NextConfig,
  root: string,
): Promise<{ aliases: Record<string, string>; mdx: MdxOptions | null }> {
  if (typeof config.webpack !== "function") {
    return { aliases: {}, mdx: null };
  }

  const mockModuleRules: any[] = [];
  const mockConfig = {
    context: root,
    resolve: { alias: {} as Record<string, unknown> },
    module: { rules: mockModuleRules },
    plugins: [] as any[],
  };
  const mockOptions = {
    defaultLoaders: { babel: { loader: "next-babel-loader" } },
    isServer: false,
    dev: false,
    dir: root,
  };

  try {
    const result = await (config.webpack as Function)(mockConfig, mockOptions);
    const finalConfig = result ?? mockConfig;
    const rules: any[] = finalConfig.module?.rules ?? mockModuleRules;
    return {
      aliases: normalizeAliasEntries(finalConfig.resolve?.alias, root),
      mdx: extractMdxOptionsFromRules(rules),
    };
  } catch {
    return { aliases: {}, mdx: null };
  }
}

/**
 * Extract MDX compilation options (remark/rehype/recma plugins) from
 * a Next.js config that uses @next/mdx.
 *
 * @next/mdx wraps the config with a webpack function that injects an MDX
 * loader rule. The remark/rehype plugins are captured in that closure.
 * We probe the webpack function with a mock config to extract them.
 */
export async function extractMdxOptions(
  config: NextConfig,
  root: string = process.cwd(),
): Promise<MdxOptions | null> {
  return (await probeWebpackConfig(config, root)).mdx;
}

/**
 * Probe file candidates relative to root. Returns the first one that exists,
 * or null if none match.
 */
function probeFiles(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const abs = path.resolve(root, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const I18N_REQUEST_CANDIDATES = [
  "i18n/request.ts",
  "i18n/request.tsx",
  "i18n/request.js",
  "i18n/request.jsx",
  "src/i18n/request.ts",
  "src/i18n/request.tsx",
  "src/i18n/request.js",
  "src/i18n/request.jsx",
];

/**
 * Detect next-intl in the project and auto-register the `next-intl/config`
 * alias if needed.
 *
 * next-intl's `createNextIntlPlugin()` crashes in vinext because it calls
 * `require('next/package.json')` to check the Next.js version. Instead,
 * vinext detects next-intl and registers the alias automatically.
 *
 * Note: `require.resolve('next-intl')` walks up to parent `node_modules`
 * directories via standard Node module resolution. In a monorepo, next-intl
 * installed at the workspace root will trigger detection even if not listed
 * in the project's own package.json. This is acceptable since a workspace-root
 * install implies the user wants it available.
 *
 * Mutates `resolved.aliases` and `resolved.env` in place.
 */
export function detectNextIntlConfig(root: string, resolved: ResolvedNextConfig): void {
  // Explicit alias wins — user or plugin already set it
  if (resolved.aliases["next-intl/config"]) return;

  // Check if next-intl is installed (use main entry — some packages
  // don't expose ./package.json in their exports map)
  const require = createRequire(path.join(root, "package.json"));
  try {
    require.resolve("next-intl");
  } catch {
    return; // next-intl not installed
  }

  // Probe for the i18n request config file
  const configPath = probeFiles(root, I18N_REQUEST_CANDIDATES);
  if (!configPath) return;

  resolved.aliases["next-intl/config"] = configPath;

  if (resolved.trailingSlash) {
    resolved.env._next_intl_trailing_slash = "true";
  }
}

function extractMdxOptionsFromRules(rules: any[]): MdxOptions | null {
  // Search through webpack rules for the MDX loader injected by @next/mdx
  for (const rule of rules) {
    const loaders = extractMdxLoaders(rule);
    if (loaders) return loaders;
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
