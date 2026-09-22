import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";
import type { Logger, Plugin, PluginOption, ViteBuilder } from "vite";
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
import { runWithPreviewBuildCredentials } from "./preview-credentials.js";

type ProjectViteApi = Pick<typeof import("vite"), "build" | "loadConfigFromFile">;

export type BuildLifecycleContext = {
  cacheConfig: VinextCacheConfig | null;
  createPagesOnlyPlugins: () => PluginOption[];
  hasAppDir: boolean;
  hasPagesDir: boolean;
  nextConfig: ResolvedNextConfig;
  prerenderAll?: boolean;
  prerenderConfig: ResolvedVinextPrerenderConfig | null;
  prerenderConcurrency?: number;
  prerenderSecret: string;
  previewBuildCredentials?: Parameters<typeof runWithPreviewBuildCredentials>[1];
  revalidateSecret: string;
  root: string;
  routeRootConfig: VinextRouteRootConfig | null;
  rscBuildIdentity?: string;
  rscCompatibilityId?: string;
  skipPrerender?: boolean;
};

export type BuildLifecycleResult = {
  prerendered: boolean;
  standalone: boolean;
};

type BuildLifecycleState = {
  pagesClientAssetsBuildSession?: string;
};

async function loadProjectViteApi(root: string): Promise<ProjectViteApi> {
  let vitePath: string;
  try {
    const require = createRequire(path.join(root, "package.json"));
    vitePath = require.resolve("vite");
  } catch {
    vitePath = "vite";
  }
  return (await import(
    /* @vite-ignore */ vitePath === "vite" ? vitePath : pathToFileURL(vitePath).href
  )) as ProjectViteApi;
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    restoreEnvironment(previous);
  }
}

function isInternalBuildPlugin(plugin: Plugin): boolean {
  return (
    plugin.name.startsWith("vinext:") ||
    plugin.name.startsWith("vite:react") ||
    plugin.name.startsWith("rsc:") ||
    plugin.name === "vite-rsc-load-module-dev-proxy" ||
    plugin.name.startsWith("vite-plugin-cloudflare")
  );
}

async function loadHybridUserPlugins(root: string, mode: string): Promise<Plugin[]> {
  if (!hasViteConfig(root)) return [];
  const vite = await loadProjectViteApi(root);
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode, isSsrBuild: true },
    undefined,
    root,
  );
  const plugins = (loaded?.config.plugins as unknown[] | undefined)?.flat(Infinity) ?? [];
  return plugins.filter(
    (plugin): plugin is Plugin =>
      Boolean(plugin) &&
      typeof (plugin as Plugin).name === "string" &&
      !isInternalBuildPlugin(plugin as Plugin),
  );
}

async function buildHybridPagesBundle(
  builder: ViteBuilder,
  context: BuildLifecycleContext,
): Promise<void> {
  const vite = await loadProjectViteApi(context.root);
  const userPlugins = await loadHybridUserPlugins(context.root, builder.config.mode);
  if (builder.config.logLevel !== "silent") {
    console.log("  Building Pages Router server (hybrid)...");
  }
  await vite.build({
    root: context.root,
    mode: builder.config.mode,
    configFile: false,
    plugins: [...userPlugins, ...context.createPagesOnlyPlugins()],
    resolve: {
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    customLogger: builder.config.logger as Logger,
    build: {
      outDir: "dist/server",
      emptyOutDir: false,
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
}

function prepareBuild(builder: ViteBuilder, context: BuildLifecycleContext): BuildLifecycleState {
  if (context.nextConfig.output === "standalone") {
    const vinextDistDir = path.join(resolveVinextPackageRoot(), "dist");
    if (!fs.existsSync(vinextDistDir)) {
      throw new Error(
        `vinext dist/ not found at ${vinextDistDir}. Build the vinext package before creating standalone output.`,
      );
    }
  }

  cleanBuildOutput({
    root: context.root,
    outDir: path.resolve(context.root, "dist"),
    emptyOutDir: builder.config.build.emptyOutDir ?? undefined,
  });

  if (!context.hasAppDir || !context.hasPagesDir) return {};
  const pagesClientAssetsBuildSession = randomBytes(16).toString("hex");
  process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION = pagesClientAssetsBuildSession;
  return { pagesClientAssetsBuildSession };
}

async function finalizeBuild(
  builder: ViteBuilder,
  context: BuildLifecycleContext,
): Promise<BuildLifecycleResult> {
  if (context.hasAppDir && context.hasPagesDir) {
    await withEnvironment(
      {
        __VINEXT_SHARED_BUILD_ID: context.nextConfig.buildId,
        __VINEXT_SHARED_PRERENDER_SECRET: context.prerenderSecret,
        __VINEXT_SHARED_REVALIDATE_SECRET: context.revalidateSecret,
        __VINEXT_SHARED_RSC_BUILD_IDENTITY: context.rscBuildIdentity,
        __VINEXT_SHARED_RSC_COMPATIBILITY_ID: context.rscCompatibilityId,
      },
      () =>
        runWithPreviewBuildCredentials(
          () => buildHybridPagesBundle(builder, context),
          context.previewBuildCredentials,
        ),
    );
  }

  if (context.nextConfig.output === "standalone") {
    const { emitStandaloneOutput } = await import("./standalone.js");
    const standalone = emitStandaloneOutput({
      root: context.root,
      outDir: path.resolve(context.root, "dist"),
    });
    console.log(
      `  Generated standalone output in ${path.relative(context.root, standalone.standaloneDir)}/`,
    );
    console.log("  Start it with: node dist/standalone/server.js\n");
    return { prerendered: false, standalone: true };
  }

  const prerenderDecision = context.skipPrerender
    ? null
    : resolveVinextPrerenderDecision({
        prerenderAllFlag: context.prerenderAll,
        vinextPrerenderConfig: context.prerenderConfig,
        nextOutput: context.nextConfig.output,
      });
  let prerenderResult;
  if (prerenderDecision) {
    if (context.nextConfig.enablePrerenderSourceMaps) {
      process.setSourceMapsEnabled(true);
      Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
    }
    console.log(`  ${formatVinextPrerenderLabel(prerenderDecision)}`);
    const [{ emitPrerenderPathManifest }, { runPrerender }] = await Promise.all([
      import("./prerender-paths.js"),
      import("./run-prerender.js"),
    ]);
    prerenderResult = await runPrerender({
      root: context.root,
      concurrency: context.prerenderConcurrency,
      nextConfig: context.nextConfig,
      routeRootConfig: context.routeRootConfig,
    });
    await emitPrerenderPathManifest({
      root: context.root,
      nextConfig: context.nextConfig,
      buildIdentity: hasBuildIdentityResponseHeader(context.cacheConfig)
        ? "response-header"
        : undefined,
      responseVary: hasVerbatimResponseVary(context.cacheConfig) ? "verbatim" : undefined,
      requestRouting: hasUncachedRequestRouting(context.cacheConfig) ? "uncached-stage" : undefined,
      isResponsePolicyHeader: (name) =>
        isConfiguredCdnResponsePolicyHeader(context.cacheConfig, name),
      routeRootConfig: context.routeRootConfig,
    });
  }

  if (builder.config.logLevel !== "silent") {
    const { printBuildReport } = await import("./report.js");
    await printBuildReport({
      root: context.root,
      pageExtensions: context.nextConfig.pageExtensions,
      prerenderResult: prerenderResult ?? undefined,
    });
    console.log("\n  Build complete.\n");
  }
  return { prerendered: Boolean(prerenderDecision), standalone: false };
}

function disposeBuild(state: BuildLifecycleState): void {
  const session = state.pagesClientAssetsBuildSession;
  if (!session) return;
  clearPagesClientAssetsBuildMetadata(session);
  if (process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION === session) {
    delete process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION;
  }
}

export async function runBuildLifecycle(
  builder: ViteBuilder,
  context: BuildLifecycleContext,
): Promise<BuildLifecycleResult> {
  const state = prepareBuild(builder, context);
  try {
    await builder.buildApp();
    return await finalizeBuild(builder, context);
  } finally {
    disposeBuild(state);
  }
}
