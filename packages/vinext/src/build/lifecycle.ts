import type { Plugin, PluginOption, ViteBuilder } from "vite";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";
import {
  hasBuildIdentityResponseHeader,
  hasUncachedRequestRouting,
  hasVerbatimResponseVary,
  isConfiguredCdnResponsePolicyHeader,
  type VinextCacheConfig,
} from "../cache/cache-adapters-virtual.js";
import {
  formatVinextPrerenderLabel,
  resolveVinextPrerenderDecision,
  type ResolvedVinextPrerenderConfig,
  type VinextRouteRootConfig,
} from "../config/prerender.js";
import type { ResolvedNextConfig } from "../config/next-config.js";
import { hasViteConfig } from "../utils/project.js";
import { resolveVinextPackageRoot } from "../utils/vinext-root.js";
import { cleanBuildOutput } from "./clean-output.js";
import { clearPagesClientAssetsBuildMetadata } from "./pages-client-assets-module.js";
import type { PreviewBuildCredentials } from "./preview-credentials.js";
import { runWithPreviewBuildCredentials } from "./preview-credentials.js";

type ProjectViteApi = Pick<typeof import("vite"), "build" | "loadConfigFromFile">;

export type BuildLifecycleContext = {
  cacheConfig: VinextCacheConfig | null;
  createPagesOnlyPlugins: () => PluginOption[];
  getHasAppDir: () => boolean;
  getHasPagesDir: () => boolean;
  getNextConfig: () => ResolvedNextConfig;
  getPrerenderSecret: () => string;
  getPreviewBuildCredentials: () => PreviewBuildCredentials | undefined;
  getRevalidateSecret: () => string;
  getRoot: () => string;
  getRscBuildIdentity: () => string | undefined;
  getRscCompatibilityId: () => string | undefined;
  prerenderConfig: ResolvedVinextPrerenderConfig | null;
  prerenderConcurrency?: number;
  routeRootConfig: VinextRouteRootConfig;
  setPagesClientAssetsBuildSession: (session: string | undefined) => void;
  skip?: boolean;
};

const preparedBuilders = new WeakSet<ViteBuilder>();
const finalizedBuilders = new WeakSet<ViteBuilder>();
const hybridBuildSessions = new WeakMap<ViteBuilder, string>();

async function loadProjectViteApi(root: string): Promise<ProjectViteApi> {
  let vitePath: string;
  try {
    const require = createRequire(path.join(root, "package.json"));
    vitePath = require.resolve("vite");
  } catch {
    vitePath = "vite";
  }
  const viteUrl = vitePath === "vite" ? vitePath : pathToFileURL(vitePath).href;
  return (await import(/* @vite-ignore */ viteUrl)) as ProjectViteApi;
}

function setTemporaryEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function buildHybridPagesBundle(
  context: BuildLifecycleContext,
  mode: string,
  logLevel: ViteBuilder["config"]["logLevel"],
): Promise<void> {
  const root = context.getRoot();
  const vite = await loadProjectViteApi(root);
  let userTransformPlugins: Plugin[] = [];

  if (hasViteConfig(root)) {
    const loaded = await vite.loadConfigFromFile(
      { command: "build", mode, isSsrBuild: true },
      undefined,
      root,
    );
    if (loaded?.config.plugins) {
      const flat = (loaded.config.plugins as unknown[]).flat(Infinity) as Array<
        Plugin | null | undefined | false
      >;
      userTransformPlugins = flat.filter((plugin): plugin is Plugin => {
        if (!plugin || typeof plugin.name !== "string") return false;
        return (
          // The nested build only inherits plugins that participate in module
          // transformation. Replaying output-only plugins can run adapter or
          // environment assertions against the internal Pages bundle.
          Boolean(plugin.resolveId || plugin.load || plugin.transform) &&
          !plugin.name.startsWith("vinext:") &&
          !plugin.name.startsWith("vite:react") &&
          !plugin.name.startsWith("rsc:") &&
          plugin.name !== "vite-rsc-load-module-dev-proxy" &&
          !plugin.name.startsWith("vite-plugin-cloudflare")
        );
      });
    }
  }

  if (logLevel !== "silent") console.log("  Building Pages Router server (hybrid)...");
  await vite.build({
    root,
    mode,
    logLevel,
    configFile: false,
    plugins: [...userTransformPlugins, ...context.createPagesOnlyPlugins()],
    resolve: {
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    build: {
      outDir: "dist/server",
      emptyOutDir: false,
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: {
        output: { entryFileNames: "entry.js" },
      },
    },
  });
}

async function prepareBuild(builder: ViteBuilder, context: BuildLifecycleContext): Promise<void> {
  if (context.skip || preparedBuilders.has(builder)) return;
  preparedBuilders.add(builder);

  const root = context.getRoot();
  const nextConfig = context.getNextConfig();
  if (nextConfig.output === "standalone") {
    const vinextDistDir = path.join(resolveVinextPackageRoot(), "dist");
    if (!fs.existsSync(vinextDistDir)) {
      throw new Error(
        `vinext dist/ not found at ${vinextDistDir}. Build the vinext package before creating standalone output.`,
      );
    }
  }

  cleanBuildOutput({
    root,
    outDir: path.resolve(root, "dist"),
    emptyOutDir: builder.config.build.emptyOutDir ?? undefined,
  });

  if (context.getHasAppDir() && context.getHasPagesDir()) {
    const session = randomBytes(16).toString("hex");
    context.setPagesClientAssetsBuildSession(session);
    hybridBuildSessions.set(builder, session);
  }
}

async function ensurePrimaryBuildComplete(builder: ViteBuilder): Promise<void> {
  for (const environment of Object.values(builder.environments)) {
    if (!environment.isBuilt) await builder.build(environment);
  }
}

async function finalizeBuild(builder: ViteBuilder, context: BuildLifecycleContext): Promise<void> {
  if (context.skip || finalizedBuilders.has(builder)) return;
  finalizedBuilders.add(builder);

  const hybridSession = hybridBuildSessions.get(builder);
  try {
    // Vite may enter post-buildApp hooks before every environment has been
    // built. Finalizers consume the complete dist/ tree, so finish any
    // remaining primary environments first.
    await ensurePrimaryBuildComplete(builder);

    const root = context.getRoot();
    const nextConfig = context.getNextConfig();
    if (context.getHasAppDir() && context.getHasPagesDir()) {
      const restoreEnv = setTemporaryEnv({
        __VINEXT_SHARED_BUILD_ID: nextConfig.buildId,
        __VINEXT_SHARED_PRERENDER_SECRET: context.getPrerenderSecret(),
        __VINEXT_SHARED_REVALIDATE_SECRET: context.getRevalidateSecret(),
        __VINEXT_SHARED_RSC_BUILD_IDENTITY: context.getRscBuildIdentity(),
        __VINEXT_SHARED_RSC_COMPATIBILITY_ID: context.getRscCompatibilityId(),
      });
      try {
        await runWithPreviewBuildCredentials(
          () => buildHybridPagesBundle(context, builder.config.mode, builder.config.logLevel),
          context.getPreviewBuildCredentials(),
        );
      } finally {
        restoreEnv();
      }
    }

    if (nextConfig.output === "standalone") {
      const { emitStandaloneOutput } = await import("./standalone.js");
      const standalone = emitStandaloneOutput({ root, outDir: path.resolve(root, "dist") });
      console.log(
        `  Generated standalone output in ${path.relative(root, standalone.standaloneDir)}/`,
      );
      console.log("  Start it with: node dist/standalone/server.js\n");
      return;
    }

    const prerenderAll = process.env.VINEXT_PRERENDER_ALL === "1";
    const prerenderDecision = resolveVinextPrerenderDecision({
      prerenderAllFlag: prerenderAll,
      vinextPrerenderConfig: context.prerenderConfig,
      nextOutput: nextConfig.output,
    });
    let prerenderResult;
    if (prerenderDecision) {
      if (nextConfig.enablePrerenderSourceMaps) {
        process.setSourceMapsEnabled(true);
        Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
      }
      console.log(`  ${formatVinextPrerenderLabel(prerenderDecision)}`);
      const [{ emitPrerenderPathManifest }, { runPrerender }] = await Promise.all([
        import("./prerender-paths.js"),
        import("./run-prerender.js"),
      ]);
      const envConcurrency = process.env.VINEXT_PRERENDER_CONCURRENCY;
      const parsedEnvConcurrency = envConcurrency ? Number(envConcurrency) : undefined;
      prerenderResult = await runPrerender({
        root,
        concurrency:
          parsedEnvConcurrency && Number.isInteger(parsedEnvConcurrency) && parsedEnvConcurrency > 0
            ? parsedEnvConcurrency
            : context.prerenderConcurrency,
        nextConfig,
        routeRootConfig: context.routeRootConfig,
      });
      await emitPrerenderPathManifest({
        root,
        nextConfig,
        buildIdentity: hasBuildIdentityResponseHeader(context.cacheConfig)
          ? "response-header"
          : undefined,
        responseVary: hasVerbatimResponseVary(context.cacheConfig) ? "verbatim" : undefined,
        requestRouting: hasUncachedRequestRouting(context.cacheConfig)
          ? "uncached-stage"
          : undefined,
        isResponsePolicyHeader: (name) =>
          isConfiguredCdnResponsePolicyHeader(context.cacheConfig, name),
        routeRootConfig: context.routeRootConfig,
      });
    }

    if (builder.config.logLevel !== "silent") {
      const { printBuildReport } = await import("./report.js");
      await printBuildReport({
        root,
        pageExtensions: nextConfig.pageExtensions,
        prerenderResult: prerenderResult ?? undefined,
      });
      console.log("\n  Build complete.\n");
    }
  } finally {
    if (hybridSession) {
      clearPagesClientAssetsBuildMetadata(hybridSession);
      context.setPagesClientAssetsBuildSession(undefined);
      hybridBuildSessions.delete(builder);
    }
  }
}

export function createBuildLifecyclePlugins(context: BuildLifecycleContext): Plugin[] {
  return [
    {
      name: "vinext:build-lifecycle-prepare",
      apply: "build",
      buildApp: {
        order: "pre",
        handler(builder) {
          return prepareBuild(builder, context);
        },
      },
    },
    {
      name: "vinext:build-lifecycle-finalize",
      apply: "build",
      // Adapters such as @cloudflare/vite-plugin also use a post buildApp hook
      // to write deployment output. Run after normal-enforce adapter plugins so
      // prerendering and standalone packaging see their finalized artifacts.
      enforce: "post",
      buildApp: {
        order: "post",
        handler(builder) {
          return finalizeBuild(builder, context);
        },
      },
    },
  ];
}
