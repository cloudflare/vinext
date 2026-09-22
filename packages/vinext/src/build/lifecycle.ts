import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";
import type { Logger, Plugin, PluginOption, ResolvedConfig, UserConfig, ViteBuilder } from "vite";
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
import { flattenPluginOptions } from "../utils/plugin-options.js";
import { resolveVinextPackageRoot } from "../utils/vinext-root.js";
import { cleanBuildOutput } from "./clean-output.js";
import {
  PAGES_CLIENT_ASSETS_MODULE,
  clearPagesClientAssetsBuildMetadata,
} from "./pages-client-assets-module.js";
import { runWithPreviewBuildCredentials } from "./preview-credentials.js";

type ProjectViteApi = Pick<
  typeof import("vite"),
  "createBuilder" | "loadConfigFromFile" | "mergeConfig"
>;

export type BuildLifecycleContext = {
  cacheConfig: VinextCacheConfig | null;
  configNodeEnv?: string;
  createPagesOnlyPlugins: (pagesClientAssetsModule: string | null) => PluginOption[];
  emptyOutDir?: boolean;
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
  deferPostBuild?: boolean;
  skipHybridPagesBundle?: boolean;
};

export type BuildLifecycleResult = {
  prerendered: boolean;
  standalone: boolean;
};

export const VINEXT_BUILD_LIFECYCLE_CONFIG = "__vinextBuildLifecycle";

export type BuildLifecycleInvocation = {
  onComplete?: (result: BuildLifecycleResult) => void;
};

type BuildLifecycleState = {
  pagesClientAssetsBuildSession?: string;
  restoreBuild?: () => void;
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
    plugin.name === "rsc" ||
    plugin.name.startsWith("rsc:") ||
    plugin.name === "vite-rsc-load-module-dev-proxy" ||
    plugin.name.startsWith("vite-plugin-cloudflare")
  );
}

async function loadHybridUserConfig(
  root: string,
  mode: string,
  configFile: string | undefined,
  configNodeEnv: string | undefined,
): Promise<UserConfig> {
  if (!configFile) return {};
  const vite = await loadProjectViteApi(root);
  const load = () =>
    vite.loadConfigFromFile({ command: "build", mode, isSsrBuild: true }, configFile, root);
  const loaded = configNodeEnv
    ? await withEnvironment({ NODE_ENV: configNodeEnv }, load)
    : await load();
  if (!loaded) return {};
  const plugins = await flattenPluginOptions(loaded.config.plugins);
  return {
    ...loaded.config,
    plugins: plugins
      .filter(
        (plugin): plugin is Plugin =>
          Boolean(plugin) &&
          typeof (plugin as Plugin).name === "string" &&
          !isInternalBuildPlugin(plugin as Plugin),
      )
      // The auxiliary Pages build reuses transform/config hooks, but the
      // top-level builder remains the sole owner of application orchestration.
      .map((plugin) => ({ ...plugin, buildApp: undefined })),
  };
}

async function buildHybridPagesBundle(
  builder: ViteBuilder,
  context: BuildLifecycleContext,
): Promise<void> {
  const vite = await loadProjectViteApi(context.root);
  const userConfig = await loadHybridUserConfig(
    context.root,
    builder.config.mode,
    builder.config.configFile,
    context.configNodeEnv,
  );
  if (builder.config.logLevel !== "silent") {
    console.log("  Building Pages Router server (hybrid)...");
  }
  const userSsrEnvironment = userConfig.environments?.ssr;
  const { build: _userSsrBuild, ...pagesEnvironment } = userSsrEnvironment ?? {};
  const mergedBuild = vite.mergeConfig(userConfig.build ?? {}, userSsrEnvironment?.build ?? {});
  const userOutput = mergedBuild.rolldownOptions?.output;
  const appAssetsPath = path.resolve(
    context.root,
    builder.environments.rsc?.config.build.outDir ?? "dist/server",
    PAGES_CLIENT_ASSETS_MODULE,
  );
  const pagesClientAssetsModule = fs.existsSync(appAssetsPath)
    ? fs.readFileSync(appAssetsPath, "utf8")
    : null;
  const pagesBuild = {
    ...mergedBuild,
    outDir: "dist/server",
    emptyOutDir: false,
    // The primary App build owns the shared server manifest. Emitting another
    // one here would replace its RSC entries with the auxiliary Pages graph.
    manifest: false,
    ssr: "virtual:vinext-server-entry",
    rolldownOptions: {
      ...mergedBuild.rolldownOptions,
      output: Array.isArray(userOutput)
        ? userOutput.map((output) => ({ ...output, entryFileNames: "entry.js" }))
        : { ...userOutput, entryFileNames: "entry.js" },
    },
  };
  const pagesConfig: Parameters<typeof vite.createBuilder>[0] = {
    ...userConfig,
    root: context.root,
    mode: builder.config.mode,
    configFile: false,
    plugins: [
      ...(userConfig.plugins ?? []),
      ...context.createPagesOnlyPlugins(pagesClientAssetsModule),
    ],
    builder: {
      ...userConfig.builder,
      buildApp: async (pagesBuilder) => {
        await pagesBuilder.build(pagesBuilder.environments.ssr);
      },
    },
    environments: {
      ssr: {
        ...pagesEnvironment,
        consumer: "server",
      },
    },
    resolve: {
      ...userConfig.resolve,
      dedupe: [
        ...(userConfig.resolve?.dedupe ?? []),
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
    customLogger: builder.config.logger as Logger,
    // Vite uses the top-level SSR entry while resolving config, before the
    // environment build runs. This preserves `apply(_, { isSsrBuild })`.
    build: pagesBuild,
  };
  const createPagesBuilder = () => vite.createBuilder(pagesConfig);
  const pagesBuilder = context.configNodeEnv
    ? await withEnvironment({ NODE_ENV: context.configNodeEnv }, createPagesBuilder)
    : await createPagesBuilder();
  await pagesBuilder.buildApp();
}

function checkStandaloneBuildPrerequisite(context: BuildLifecycleContext): void {
  if (!context.deferPostBuild && context.nextConfig.output === "standalone") {
    const vinextDistDir = path.join(resolveVinextPackageRoot(), "dist");
    if (!fs.existsSync(vinextDistDir)) {
      throw new Error(
        `vinext dist/ not found at ${vinextDistDir}. Build the vinext package before creating standalone output.`,
      );
    }
  }
}

export function prepareBuildOutput(
  context: BuildLifecycleContext,
  emptyOutDir = context.emptyOutDir,
): void {
  checkStandaloneBuildPrerequisite(context);

  cleanBuildOutput({
    root: context.root,
    outDir: path.resolve(context.root, "dist"),
    emptyOutDir,
  });
}

function prepareBuild(context: BuildLifecycleContext): BuildLifecycleState {
  if (!context.hasAppDir || !context.hasPagesDir) return {};
  const pagesClientAssetsBuildSession = randomBytes(16).toString("hex");
  process.env.__VINEXT_PAGES_CLIENT_ASSETS_BUILD_SESSION = pagesClientAssetsBuildSession;
  return { pagesClientAssetsBuildSession };
}

async function finalizeBuild(
  builder: ViteBuilder,
  context: BuildLifecycleContext,
): Promise<BuildLifecycleResult> {
  if (context.hasAppDir && context.hasPagesDir && !context.skipHybridPagesBundle) {
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

  if (context.deferPostBuild) {
    return { prerendered: false, standalone: false };
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

  const prerenderDecision = resolveVinextPrerenderDecision({
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

  const { printBuildReport } = await import("./report.js");
  await printBuildReport({
    root: context.root,
    pageExtensions: context.nextConfig.pageExtensions,
    prerenderResult: prerenderResult ?? undefined,
  });
  console.log("\n  Build complete.\n");
  return { prerendered: Boolean(prerenderDecision), standalone: false };
}

function disposeBuild(state: BuildLifecycleState): void {
  state.restoreBuild?.();
  state.restoreBuild = undefined;
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
  const state = prepareBuild(context);
  try {
    await builder.buildApp();
    return await finalizeBuild(builder, context);
  } finally {
    disposeBuild(state);
  }
}

export function createBuildLifecyclePlugins(options: {
  createContext: () => BuildLifecycleContext;
  isEnabled: (builder: ViteBuilder) => boolean;
  onComplete?: (result: BuildLifecycleResult) => void;
  onPrepare?: () => void;
  shouldDeferPostBuild?: () => boolean;
  shouldPrepare: (config: UserConfig | ResolvedConfig) => boolean;
  shouldBuildPlainPages: () => boolean;
}): Plugin[] {
  let outputPrepared = false;
  const createContext = (): BuildLifecycleContext => ({
    ...options.createContext(),
    deferPostBuild: options.shouldDeferPostBuild?.(),
  });
  const finalizePlugin: Plugin = {
    name: "vinext:build-lifecycle-finalize",
    apply: "build",
    enforce: "post",
    configResolved: {
      order: "post",
      handler(config) {
        const plugins = config.plugins as Plugin[];
        const index = plugins.indexOf(finalizePlugin);
        if (index !== -1 && index !== plugins.length - 1) {
          plugins.push(...plugins.splice(index, 1));
        }
      },
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        if (!options.isEnabled(builder)) return;
        const result = await finalizeBuild(builder, createContext());
        options.onComplete?.(result);
      },
    },
  };
  return [
    {
      name: "vinext:build-lifecycle-prepare",
      apply: "build",
      configResolved: {
        order: "pre",
        handler(config) {
          if (outputPrepared || !options.shouldPrepare(config)) return;
          const context = createContext();
          if (config.build.emptyOutDir === false) context.emptyOutDir = false;
          // Fail before onPrepare can install or upgrade dependencies.
          checkStandaloneBuildPrerequisite(context);
          options.onPrepare?.();
          prepareBuildOutput(context);
          outputPrepared = true;
        },
      },
      buildApp: {
        order: "pre",
        async handler(builder) {
          if (!options.isEnabled(builder) || !options.shouldBuildPlainPages()) return;
          for (const name of ["client", "ssr"]) {
            const environment = builder.environments[name];
            if (environment && !environment.isBuilt) await builder.build(environment);
          }
        },
      },
    },
    finalizePlugin,
  ];
}
