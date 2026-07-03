import type { PluginOption } from "vite";
import { isUnknownRecord } from "../utils/record.js";
export {
  findVinextCacheConfigInPlugins,
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
    };

export type ResolvedVinextPrerenderConfig = {
  routes: "*";
};

export type VinextPrerenderDecisionReason = "flag" | "next-export" | "vinext-config";

export type VinextPrerenderDecision = ResolvedVinextPrerenderConfig & {
  reason: VinextPrerenderDecisionReason;
};

// Custom metadata key attached to vinext's config plugin so fresh Vite config
// loads can recover the normalized prerender option without re-parsing user code.
export const VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY = "__vinextPrerenderConfig";

type VinextPrerenderConfigPlugin = {
  [VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY]?: ResolvedVinextPrerenderConfig | null;
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

  if (config.routes === "*") return { routes: "*" };

  throw new Error(
    '[vinext] Unsupported `prerender.routes` config. Currently only `routes: "*"` is supported.',
  );
}

function flattenPluginOptions(value: unknown, target: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenPluginOptions(item, target);
    return;
  }
  if (value) target.push(value);
}

export function findVinextPrerenderConfigInPlugins(
  plugins: PluginOption[] | undefined,
): ResolvedVinextPrerenderConfig | null {
  const flattened: unknown[] = [];
  flattenPluginOptions(plugins, flattened);

  for (const plugin of flattened) {
    if (!isUnknownRecord(plugin)) continue;
    const prerenderConfig = (plugin as VinextPrerenderConfigPlugin)[
      VINEXT_PRERENDER_CONFIG_PLUGIN_PROPERTY
    ];
    if (prerenderConfig) return prerenderConfig;
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
  return findVinextPrerenderConfigInPlugins(loaded?.config.plugins);
}

export function resolveVinextPrerenderDecision(options: {
  prerenderAllFlag?: boolean;
  vinextPrerenderConfig?: ResolvedVinextPrerenderConfig | null;
  nextOutput?: string;
}): VinextPrerenderDecision | null {
  if (options.prerenderAllFlag) return { routes: "*", reason: "flag" };
  if (options.nextOutput === "export") return { routes: "*", reason: "next-export" };
  if (options.vinextPrerenderConfig?.routes === "*") {
    return { routes: "*", reason: "vinext-config" };
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
