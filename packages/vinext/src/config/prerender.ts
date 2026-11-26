import path from "pathslash";
import type { PluginOption } from "vite";
import { assertClientOutDirIsSeparate } from "../build/client-build-config.js";
import { assertOutputDirIsSafe } from "../build/clean-output.js";
import { flattenPluginOptions } from "../utils/plugin-options.js";
import { findDir } from "../utils/project.js";
import { isUnknownRecord } from "../utils/record.js";
import type { ResolvedNextConfig } from "./next-config.js";
export {
  findVinextCacheConfigInPlugins,
  isConfiguredCdnResponsePolicyHeader,
  hasBuildIdentityResponseHeader,
  hasUncachedRequestRouting,
  hasVerbatimResponseVary,
  supportsCanonicalRscWarmup,
  cacheWarmupStatusSource,
  hasCacheAdapterPrerenderOutput,
  finalizeCacheAdapterPrerenderOutput,
  requiresRouteCacheabilityProbeManifest,
  loadVinextCacheConfigFromViteConfig,
  VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY,
  type VinextCacheConfig,
} from "../cache/cache-adapters-virtual.js";

export type VinextPrerenderConfig =
  | true
  | {
      /**
       * Routes to pre-render after the production build.
       *
       * Currently only `"*"` is supported, which pre-renders every discovered
       * App Router and Pages Router route that vinext can statically render.
       */
      routes: "*";
      /** Maximum number of routes to render concurrently. */
      concurrency?: number;
    };

export type ResolvedVinextPrerenderConfig = {
  routes: "*";
  concurrency?: number;
};

export type VinextPrerenderDecisionReason = "flag" | "next-export" | "vinext-config";

export type VinextPrerenderDecision = ResolvedVinextPrerenderConfig & {
  reason: VinextPrerenderDecisionReason;
};

// Custom metadata key attached to vinext's config plugin so fresh Vite config
// loads can recover the normalized prerender option without re-parsing user code.
export const VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY = "__vinextPrerenderConfig";
export const VINEXT_ROUTE_ROOT_CONFIG_PLUGIN_PROPERTY = "__vinextRouteRootConfig";

export type VinextRouteRootConfig = {
  appDir?: string;
  clientOutDir?: string;
  disableAppRouter?: boolean;
  /** Root of the build output (Vite's `build.outDir`). Defaults to "dist". */
  outDir?: string;
  rscOutDir?: string;
  ssrOutDir?: string;
};

export function resolveStaticExportDistDir(
  root: string,
  { output, distDir }: Pick<ResolvedNextConfig, "output" | "distDir">,
): string | undefined {
  return output === "export" && distDir && distDir !== ".next"
    ? path.resolve(root, distDir)
    : undefined;
}

/** Validate an export destination inferred without running the Vite build hooks. */
export function resolvePrebuiltStaticExportClientDir(options: {
  projectRoot: string;
  configRoot: string;
  nextConfig: ResolvedNextConfig;
  routeRootConfig: VinextRouteRootConfig;
  publicDir?: string | false;
}): string | undefined {
  const { projectRoot, configRoot, nextConfig, routeRootConfig, publicDir = "public" } = options;
  const clientOutDir = resolveStaticExportDistDir(configRoot, nextConfig);
  if (clientOutDir === undefined) return;

  assertClientOutDirIsSeparate(configRoot, { ...routeRootConfig, clientOutDir });
  for (const root of new Set([projectRoot, configRoot])) {
    const sourceRoot = path.resolve(root, routeRootConfig.appDir ?? ".");
    assertOutputDirIsSafe("client output directory", clientOutDir, {
      root,
      protectedDirs: {
        app: findDir(sourceRoot, "app", "src/app"),
        pages: findDir(sourceRoot, "pages", "src/pages"),
        public: publicDir && path.resolve(root, publicDir),
      },
    });
  }
  return clientOutDir;
}

type VinextPrerenderConfigPlugin = {
  [VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY]?: ResolvedVinextPrerenderConfig | null;
  [VINEXT_ROUTE_ROOT_CONFIG_PLUGIN_PROPERTY]?: VinextRouteRootConfig | null;
};

type ViteConfigLoader = {
  loadConfigFromFile: typeof import("vite").loadConfigFromFile;
};

export function normalizeVinextPrerenderConfig(
  config: VinextPrerenderConfig | undefined,
): ResolvedVinextPrerenderConfig | null {
  if (config === undefined) return null;
  if (config === true) return { routes: "*" };

  if (!isUnknownRecord(config)) {
    throw new Error('[vinext] Invalid `prerender` config. Use `true` or `{ routes: "*" }`.');
  }

  if (config.routes === "*") {
    if (
      config.concurrency !== undefined &&
      (!Number.isInteger(config.concurrency) || config.concurrency <= 0)
    ) {
      throw new Error("[vinext] `prerender.concurrency` must be a positive integer.");
    }
    return {
      routes: "*",
      ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    };
  }

  throw new Error(
    '[vinext] Unsupported `prerender.routes` config. Currently only `routes: "*"` is supported.',
  );
}

export async function findVinextPrerenderConfigInPlugins(
  plugins: PluginOption[] | undefined,
): Promise<ResolvedVinextPrerenderConfig | null> {
  const flattened = await flattenPluginOptions(plugins);

  for (const plugin of flattened) {
    if (!isUnknownRecord(plugin)) continue;
    const prerenderConfig = (plugin as VinextPrerenderConfigPlugin)[
      VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY
    ];
    if (prerenderConfig) return prerenderConfig;
  }

  return null;
}

export async function findVinextRouteRootConfigInPlugins(
  plugins: PluginOption[] | undefined,
): Promise<VinextRouteRootConfig | null> {
  const flattened = await flattenPluginOptions(plugins);

  for (const plugin of flattened) {
    if (!isUnknownRecord(plugin)) continue;
    const routeRootConfig = (plugin as VinextPrerenderConfigPlugin)[
      VINEXT_ROUTE_ROOT_CONFIG_PLUGIN_PROPERTY
    ];
    if (routeRootConfig) return routeRootConfig;
  }

  return null;
}

export async function loadVinextPrerenderConfigFromViteConfig(
  vite: ViteConfigLoader,
  root: string,
): Promise<ResolvedVinextPrerenderConfig | null> {
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  return await findVinextPrerenderConfigInPlugins(loaded?.config.plugins);
}

export async function loadVinextRouteRootConfigFromViteConfig(
  vite: ViteConfigLoader,
  root: string,
): Promise<VinextRouteRootConfig | null> {
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  return await findVinextRouteRootConfigInPlugins(loaded?.config.plugins);
}

export function resolveVinextPrerenderDecision(options: {
  prerenderAllFlag?: boolean;
  vinextPrerenderConfig?: ResolvedVinextPrerenderConfig | null;
  nextOutput?: string;
}): VinextPrerenderDecision | null {
  if (options.prerenderAllFlag) return { routes: "*", reason: "flag" };
  if (options.nextOutput === "export") return { routes: "*", reason: "next-export" };
  if (options.vinextPrerenderConfig?.routes === "*") {
    return { ...options.vinextPrerenderConfig, reason: "vinext-config" };
  }
  return null;
}

export function formatVinextPrerenderLabel(decision: VinextPrerenderDecision): string {
  if (decision.reason === "next-export") {
    return "Pre-rendering all routes (output: 'export')...";
  }
  if (decision.reason === "vinext-config") {
    return "Pre-rendering all routes (vinext prerender config)...";
  }
  return "Pre-rendering all routes...";
}
