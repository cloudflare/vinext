import type { Plugin } from "vite";
import {
  CACHEABILITY_MANIFEST_MODULE_FILE,
  CACHEABILITY_MANIFEST_PLACEHOLDER,
} from "../server/cacheability-manifest.js";

type WranglerOutputConfig = Record<string, unknown> & {
  main?: unknown;
  rules?: unknown;
};

type WranglerModuleRule = {
  fallthrough?: unknown;
  globs?: unknown;
  type?: unknown;
};

function readAssetText(asset: { source: string | Uint8Array }): string {
  return typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
}

function isManifestTextRule(rule: unknown, manifestGlob: string): boolean {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  const candidate = rule as WranglerModuleRule;
  return (
    candidate.type === "Text" &&
    Array.isArray(candidate.globs) &&
    candidate.globs.includes(manifestGlob)
  );
}

/**
 * Keep Cloudflare Worker build output deployable before it has a probe result.
 * The generated entry imports one attached text module; ordinary deployments
 * receive this inert placeholder, while the two-stage deploy replaces only the
 * text file in an isolated upload tree.
 */
export function createCacheabilityManifestModulePlugin(): Plugin {
  return {
    name: "vinext:cacheability-manifest-module",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const wranglerAsset = bundle["wrangler.json"];
        if (!wranglerAsset || wranglerAsset.type !== "asset") return;

        let config: WranglerOutputConfig;
        try {
          const parsed = JSON.parse(readAssetText(wranglerAsset)) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Wrangler output config is not an object.");
          }
          config = parsed as WranglerOutputConfig;
        } catch (error) {
          throw new Error("Cloudflare generated an invalid dist/server/wrangler.json asset.", {
            cause: error,
          });
        }
        if (typeof config.main !== "string" || config.main.length === 0) {
          throw new Error("Cloudflare generated a Worker config without a main module.");
        }
        if (!Array.isArray(config.rules)) {
          throw new Error("Cloudflare generated a Worker config without module rules.");
        }

        const mainDirectory = config.main.includes("/")
          ? config.main.slice(0, config.main.lastIndexOf("/") + 1)
          : "";
        const manifestAssetPath = `${mainDirectory}${CACHEABILITY_MANIFEST_MODULE_FILE}`;
        const manifestGlob = CACHEABILITY_MANIFEST_MODULE_FILE;
        if (!config.rules.some((rule) => isManifestTextRule(rule, manifestGlob))) {
          config.rules = [
            ...config.rules,
            { fallthrough: true, globs: [manifestGlob], type: "Text" },
          ];
        }
        wranglerAsset.source = JSON.stringify(config);
        this.emitFile({
          type: "asset",
          fileName: manifestAssetPath,
          source: CACHEABILITY_MANIFEST_PLACEHOLDER,
        });
      },
    },
  };
}
