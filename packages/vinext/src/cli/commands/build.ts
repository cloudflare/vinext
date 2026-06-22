/**
 * `vinext build` — build for production.
 *
 * Detects App Router (`app/`) or Pages Router (`pages/`) and runs the
 * appropriate multi-environment build via Vite. The command's flags and help
 * text are both derived from the {@link CommandSpec} below.
 */

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import vinext from "../../index.js";
import { defineCommand } from "../command.js";
import {
  applyViteConfigCompatibility,
  buildViteConfig,
  getViteVersion,
  loadVite,
  type ViteModule,
} from "../runtime.js";
import { detectPackageManager, hasAppDir, hasViteConfig } from "../../utils/project.js";
import { getReactUpgradeDeps } from "../../init.js";
import { loadDotenv } from "../../config/dotenv.js";
import {
  createRscCompatibilityId,
  loadNextConfig,
  resolveNextConfig,
  PHASE_PRODUCTION_BUILD,
} from "../../config/next-config.js";
import { emitStandaloneOutput } from "../../build/standalone.js";
import { cleanBuildOutput } from "../../build/clean-output.js";
import { runPrerender } from "../../build/run-prerender.js";
import { resolveVinextPackageRoot } from "../../utils/vinext-root.js";

// ─── Build logger ───────────────────────────────────────────────────────────

/**
 * Create a custom Vite logger for build output.
 *
 * By default Vite/Rollup emit a lot of build noise: version banners, progress
 * lines, chunk size tables, minChunkSize diagnostics, and various internal
 * warnings that are either not actionable or already handled by vinext at
 * runtime. This logger suppresses all of that while keeping the things that
 * actually matter:
 *
 *   KEPT
 *   ✓ N modules transformed.     — confirms the transform phase completed
 *   ✓ built in Xs                — build timing (useful perf signal)
 *   Genuine warnings/errors      — anything the user may need to act on
 *
 *   SUPPRESSED (info)
 *   vite vX.Y.Z building...      — Vite version banner
 *   transforming... / rendering chunks... / computing gzip size...
 *   Initially, there are N chunks...  — Rollup minChunkSize diagnostics
 *   After merging chunks, there are...
 *   X are below minChunkSize.
 *   Blank lines
 *   Chunk/asset size table rows  — e.g. "  dist/client/assets/foo.js  42 kB"
 *   [rsc] / [ssr] / [client] / [worker] — RSC plugin env section headers
 *
 *   SUPPRESSED (warn)
 *   "dynamic import will not move module into another chunk"  — internal chunking note
 *   "X is not exported by virtual:vinext-*"  — handled gracefully at runtime
 */
function createBuildLogger(vite: ViteModule): import("vite").Logger {
  const logger = vite.createLogger("info", { allowClearScreen: false });
  const originalInfo = logger.info.bind(logger);
  const originalWarn = logger.warn.bind(logger);

  // Strip ANSI escape codes for pattern matching (keep originals for output).
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // oxlint-disable-line no-control-regex

  logger.info = (msg: string, options?: import("vite").LogOptions) => {
    const plain = strip(msg);

    // Always keep timing lines ("✓ built in 1.23s", "✓ 75 modules transformed.").
    if (plain.trimStart().startsWith("✓")) {
      originalInfo(msg, options);
      return;
    }

    // Vite version banner: "vite v6.x.x building for production..."
    if (/^vite v\d/.test(plain.trim())) return;

    // Rollup progress noise: "transforming...", "rendering chunks...", "computing gzip size..."
    if (/^(transforming|rendering chunks|computing gzip size)/.test(plain.trim())) return;

    // Rollup minChunkSize diagnostics:
    //   "Initially, there are\n36 chunks, of which\n..."
    //   "After merging chunks, there are\n..."
    //   "X are below minChunkSize."
    if (/^(Initially,|After merging|are below minChunkSize)/.test(plain.trim())) return;

    // Blank / whitespace-only separator lines.
    if (/^\s*$/.test(plain)) return;

    // Chunk/asset size table rows — e.g.:
    //   "  dist/client/assets/foo.js    42.10 kB │ gzip: 6.74 kB"  (TTY: indented)
    //   "dist/client/assets/foo.js    42.10 kB │ gzip: 6.74 kB"    (non-TTY: at column 0)
    // Both start with "dist/" (possibly preceded by whitespace).
    if (/^\s*(dist\/|\.\/)/.test(plain)) return;

    // @vitejs/plugin-rsc environment section headers ("[rsc]", "[ssr]", "[client]", "[worker]").
    if (/^\s*\[(rsc|ssr|client|worker)\]/.test(plain)) return;

    originalInfo(msg, options);
  };

  logger.warn = (msg: string, options?: import("vite").LogOptions) => {
    const plain = strip(msg);

    // Rollup: "dynamic import will not move module into another chunk" — this is
    // emitted as a [plugin vite:reporter] warning with long absolute file paths.
    // It's an internal chunking note, not actionable.
    if (plain.includes("dynamic import will not move module into another chunk")) return;

    // Rollup: "X is not exported by Y" from virtual entry modules — these come from
    // Rollup's static analysis of the generated virtual:vinext-server-entry when the
    // user's middleware doesn't export the expected names. The vinext runtime handles
    // missing exports gracefully, so this is noise.
    if (plain.includes("is not exported by") && plain.includes("virtual:vinext")) return;

    originalWarn(msg, options);
  };

  return logger;
}

function hasPagesDir(): boolean {
  return (
    fs.existsSync(path.join(process.cwd(), "pages")) ||
    fs.existsSync(path.join(process.cwd(), "src", "pages"))
  );
}

async function loadBuildEmptyOutDir(vite: ViteModule, root: string): Promise<boolean | undefined> {
  if (!hasViteConfig(root)) return undefined;

  // Read the raw user config before the multi-environment build so
  // `build.emptyOutDir: false` remains an escape hatch for vinext's upfront clean.
  const loaded = await vite.loadConfigFromFile(
    { command: "build", mode: "production" },
    undefined,
    root,
  );
  const emptyOutDir = loaded?.config.build?.emptyOutDir;
  return typeof emptyOutDir === "boolean" ? emptyOutDir : undefined;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const buildCommand = defineCommand({
  name: "build",
  summary: "Build for production",
  description:
    "Automatically detects App Router (app/) or Pages Router (pages/) and runs the\n" +
    "appropriate multi-environment build via Vite. If next.config sets\n" +
    'output: "standalone", also emits dist/standalone/server.js.',
  args: {
    verbose: {
      type: "boolean",
      description: "Show full Vite/Rollup build output (suppressed by default)",
    },
    "prerender-all": {
      type: "boolean",
      description: "Pre-render discovered routes after building",
    },
    "prerender-concurrency": {
      type: "positiveInt",
      valueHint: "count",
      description: "Maximum number of routes to pre-render in parallel",
    },
    precompress: {
      type: "boolean",
      description: "Precompress static assets at build time (.br, .gz, .zst)",
    },
    turbopack: {
      type: "boolean",
      hidden: true,
      description: "Accepted for `next build` compatibility (no-op, Vite is always used)",
    },
  },
  async run({ values }) {
    if (values.precompress) {
      process.env.VINEXT_PRECOMPRESS = "1";
    }

    loadDotenv({
      root: process.cwd(),
      mode: "production",
    });

    // Ensure "type": "module" in package.json before Vite loads vite.config.ts.
    // Without this, Vite bundles the config as CJS and tries require() on pure-ESM
    // packages like @cloudflare/vite-plugin, which fails on Node 22.
    applyViteConfigCompatibility(process.cwd());

    const vite = await loadVite();
    const viteMajorVersion = Number.parseInt(vite.version, 10) || 7;

    const withBuildBundlerOptions = (bundlerOptions: Record<string, unknown>) =>
      viteMajorVersion >= 8
        ? { rolldownOptions: bundlerOptions }
        : { rollupOptions: bundlerOptions };

    console.log(`\n  vinext build  (Vite ${getViteVersion()})\n`);

    const root = process.cwd();
    const isApp = hasAppDir(process.cwd());
    const resolvedNextConfig = await resolveNextConfig(
      await loadNextConfig(root, PHASE_PRODUCTION_BUILD),
      root,
    );

    // Coordinate a single build ID across every vinext() plugin instance in this
    // build. A hybrid app+pages build runs the App Router multi-environment build
    // (buildApp) and a separate Pages Router SSR build (vite.build) as distinct
    // plugin instances; without this, each resolves its own (potentially random)
    // ID and the runtime, prerender manifest, and dist/server/BUILD_ID disagree.
    // We resolve it once here — resolveNextConfig() already ran resolveBuildId()
    // honoring the user's generateBuildId (including the null→UUID fallback) — and
    // share that authoritative value via env so every plugin instance adopts it.
    //
    // Not cleaned up intentionally: `vinext build` runs once and the process
    // exits, so there is no in-process reuse to leak into. The var is namespaced
    // to vinext's build flow and is never read by dev or standalone resolveBuildId.
    process.env.__VINEXT_SHARED_BUILD_ID = resolvedNextConfig.buildId;

    // Same coordination for the App Router RSC compatibility token. Without a
    // pinned deploymentId, createRscCompatibilityId() mints a random UUID per
    // plugin instance, so a hybrid app+pages build would bake two different
    // compatibility tokens. Resolve it once and share it (see the plugin's
    // adoption site). Reuses deploymentId when set (already stable across
    // instances).
    process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID = createRscCompatibilityId(resolvedNextConfig);

    // On-demand ISR revalidation secret — the vinext analog of Next.js's
    // prerender-manifest `previewModeId`. `res.revalidate()` loops back into the
    // server via an internal `fetch()`; on Cloudflare Workers that loopback can
    // land on a *different* isolate than the sender, so a per-process random
    // secret would mismatch and false-reject legitimate revalidations. We instead
    // generate one 256-bit secret here, once per build, and bake it (server-only)
    // into every server bundle via Vite `define` so all isolates share the exact
    // same value. Resolved once and shared across plugin instances exactly like
    // __VINEXT_SHARED_BUILD_ID so a hybrid app+pages build bakes a single secret.
    // A fresh secret per build means it rotates with every deployment.
    if (!process.env.__VINEXT_SHARED_REVALIDATE_SECRET) {
      process.env.__VINEXT_SHARED_REVALIDATE_SECRET = randomBytes(32).toString("hex");
    }

    const outputMode = resolvedNextConfig.output;
    const distDir = path.resolve(root, "dist");

    // Pre-flight check: verify vinext's own dist/ exists before starting the build.
    // Without this, a missing dist/ (e.g. from a broken install) only surfaces after
    // the full multi-minute Vite build completes, when emitStandaloneOutput runs.
    if (outputMode === "standalone") {
      const vinextDistDir = path.join(resolveVinextPackageRoot(), "dist");
      if (!fs.existsSync(vinextDistDir)) {
        console.error(
          `  Error: vinext dist/ not found at ${vinextDistDir}. Run \`pnpm run build\` in the vinext package first.`,
        );
        process.exit(1);
      }
    }

    // In verbose mode, skip the custom logger so raw Vite/Rollup output is shown.
    const logger = values.verbose
      ? vite.createLogger("info", { allowClearScreen: false })
      : createBuildLogger(vite);

    // For App Router: upgrade React if needed for react-server-dom-webpack compatibility.
    // Without this, builds with older React versions can produce a Worker that crashes at
    // runtime with "Cannot read properties of undefined (reading 'moduleMap')".
    if (isApp) {
      const reactUpgrade = getReactUpgradeDeps(process.cwd());
      if (reactUpgrade.length > 0) {
        const installCmd = detectPackageManager(process.cwd()).replace(/ -D$/, "");
        const [pm, ...pmArgs] = installCmd.split(" ");
        console.log("  Upgrading React for RSC compatibility...");
        execFileSync(pm, [...pmArgs, ...reactUpgrade], {
          cwd: process.cwd(),
          stdio: "inherit",
          shell: process.platform === "win32",
        });
      }
    }

    cleanBuildOutput({
      root,
      outDir: distDir,
      emptyOutDir: await loadBuildEmptyOutDir(vite, root),
    });

    // All paths (App Router, Pages Router + Cloudflare, Pages Router plain Node)
    // use createBuilder + buildApp(). vinext() defines the appropriate environments
    // in its config() hook for each case, so cloudflare() and the plain Node SSR
    // build both work correctly.
    const config = buildViteConfig({}, logger);
    const builder = await vite.createBuilder(config);
    await builder.buildApp();

    if (isApp) {
      // Hybrid app (both app/ and pages/ directories): also build the Pages Router
      // SSR bundle so the prerender phase can render Pages Router routes.
      // The App Router multi-env build (buildApp) doesn't include the Pages Router
      // SSR entry, so we run it as a separate step here.
      // We use configFile: false with vinext({ disableAppRouter: true }) to avoid
      // loading the user's vite.config (which has vinext() without disableAppRouter)
      // and to prevent the multi-env environments config from overriding our SSR
      // input and entryFileNames.
      if (hasPagesDir()) {
        console.log("  Building Pages Router server (hybrid)...");
        // Inherit transform plugins from the user's vite.config (e.g. SVG loaders,
        // CSS-in-JS) that vinext doesn't auto-register. We load the raw config via
        // loadConfigFromFile — before any plugin config() hooks fire — so that
        // cloudflare() hasn't yet injected its multi-env environments block.
        // We then exclude the plugin families that vinext({ disableAppRouter: true })
        // will re-register itself, and cloudflare() which must not run here.
        const root = process.cwd();
        let userTransformPlugins: import("vite").PluginOption[] = [];
        if (hasViteConfig(process.cwd())) {
          const loaded = await vite.loadConfigFromFile(
            { command: "build", mode: "production", isSsrBuild: true },
            undefined,
            root,
          );
          if (loaded?.config.plugins) {
            const flat = (loaded.config.plugins as unknown[]).flat(Infinity) as {
              name?: string;
            }[];
            userTransformPlugins = flat.filter(
              (p): p is import("vite").Plugin =>
                !!p &&
                typeof p.name === "string" &&
                // vinext and its sub-plugins — re-registered below
                !p.name.startsWith("vinext:") &&
                // @vitejs/plugin-react — auto-registered by vinext
                !p.name.startsWith("vite:react") &&
                // @vitejs/plugin-rsc and its sub-plugins — App Router only
                !p.name.startsWith("rsc:") &&
                p.name !== "vite-rsc-load-module-dev-proxy" &&
                // vite-tsconfig-paths — auto-registered by vinext
                p.name !== "vite-tsconfig-paths" &&
                // cloudflare() — injects multi-env environments block which
                // conflicts with the plain SSR build config below
                !p.name.startsWith("vite-plugin-cloudflare"),
            );
          }
        }
        await vite.build({
          root,
          configFile: false,
          plugins: [...userTransformPlugins, vinext({ disableAppRouter: true })],
          resolve: {
            dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
          },
          ...(logger ? { customLogger: logger } : {}),
          build: {
            outDir: "dist/server",
            emptyOutDir: false, // preserve RSC artefacts from buildApp()
            ssr: "virtual:vinext-server-entry",
            ...withBuildBundlerOptions({
              output: {
                entryFileNames: "entry.js",
              },
            }),
          },
        });
      }
    }

    if (outputMode === "standalone") {
      const standalone = emitStandaloneOutput({
        root: process.cwd(),
        outDir: distDir,
      });
      console.log(
        `  Generated standalone output in ${path.relative(process.cwd(), standalone.standaloneDir)}/`,
      );
      console.log("  Start it with: node dist/standalone/server.js\n");
      return process.exit(0);
    }

    let prerenderResult;
    const shouldPrerender = values["prerender-all"] || resolvedNextConfig.output === "export";

    if (shouldPrerender) {
      // Enable Node.js built-in sourcemap support so prerender error stack
      // traces resolve through the server bundle's sourcemaps to show original
      // source files. Matches Next.js's enablePrerenderSourceMaps default.
      if (resolvedNextConfig.enablePrerenderSourceMaps) {
        process.setSourceMapsEnabled(true);
        Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
      }
      const label = values["prerender-all"]
        ? "Pre-rendering all routes..."
        : "Pre-rendering all routes (output: 'export')...";
      process.stdout.write("\x1b[0m");
      console.log(`  ${label}`);
      prerenderResult = await runPrerender({
        root: process.cwd(),
        concurrency: values["prerender-concurrency"],
      });
    }

    // Precompression runs as a Vite plugin writeBundle hook (vinext:precompress).
    // Opt-in via --precompress CLI flag or `precompress: true` in plugin options.

    process.stdout.write("\x1b[0m");
    const { printBuildReport } = await import("../../build/report.js");
    await printBuildReport({
      root: process.cwd(),
      pageExtensions: resolvedNextConfig.pageExtensions,
      prerenderResult: prerenderResult ?? undefined,
    });

    console.log("\n  Build complete. Run `vinext start` to start the production server.\n");
    process.exit(0);
  },
});
