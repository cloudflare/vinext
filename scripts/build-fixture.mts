#!/usr/bin/env node
/**
 * Build a test fixture for production from the repo's vinext source, into a
 * fresh directory outside the repo.
 *
 *   node scripts/build-fixture.mts <fixture-dir> [--out <dir>] [--json]
 *
 * Prints the build output directory (the folder holding `client/` and
 * `server/`). With `--json`, prints one JSON object instead:
 * `{ outDir, clientManifest, entryChunk }`. Everything the build logs goes to
 * stderr, so stdout carries only the result. The build runs in a child process
 * whose stdout is wired to this process's stderr, because Rolldown's native
 * reporter writes to file descriptor 1 directly and cannot be redirected from
 * JavaScript.
 *
 * `--out <dir>` names an empty (or missing) directory outside the repo; the
 * fixture is copied to `<dir>/<fixture name>` and built there.
 *
 * Runs directly on Node >=24 via native type stripping. vinext loads from
 * `packages/vinext/src` through Vite's module runner, the same way the tests do.
 */

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { inspect, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createBuilder,
  createServer,
  createServerModuleRunner,
  type PluginOption,
  type RunnableDevEnvironment,
} from "vite";

type ManifestEntry = { file: string; isEntry?: boolean };
type BuildResult = { outDir: string; clientManifest: string; entryChunk: string };

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const VINEXT_SRC = join(REPO_ROOT, "packages/vinext/src");
const CHILD_ENV = "VINEXT_BUILD_FIXTURE_CHILD";

// Mirrors WORKSPACE_SRC_ALIAS in vite.config.ts so workspace imports resolve to source.
const WORKSPACE_SRC_ALIAS = {
  "vinext/shims": join(VINEXT_SRC, "shims"),
  "vinext/internal": VINEXT_SRC,
  "@vinext/cloudflare/internal": join(REPO_ROOT, "packages/cloudflare/src"),
  "@vinext/cloudflare/cache": join(REPO_ROOT, "packages/cloudflare/src/cache"),
  "@vinext/cloudflare/images": join(REPO_ROOT, "packages/cloudflare/src/images"),
};

const USAGE = "Usage: node scripts/build-fixture.mts <fixture-dir> [--out <dir>] [--json]";

class UsageError extends Error {}

function parseCli(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, out: { type: "string" } },
  });
  if (positionals.length !== 1) throw new UsageError(`Expected one fixture directory.\n${USAGE}`);
  return { fixtureDir: resolve(positionals[0]), json: values.json === true, out: values.out };
}

/**
 * Copies the fixture into `<base>/<fixture name>` so the build never writes
 * into the repo. Module resolution mirrors an in-repo build: the fixture's own
 * node_modules entries are linked first, and `<base>/node_modules` links to the
 * repo root's so anything else resolves by walking up, as it does in the repo.
 */
function prepareWorkspace(fixtureDir: string, out: string | undefined): string {
  const requested = out ? resolve(out) : mkdtempSync(join(tmpdir(), "vinext-fixture-"));
  if (requested === REPO_ROOT || requested.startsWith(REPO_ROOT + sep)) {
    throw new UsageError(`--out must be outside the repo (got ${requested}).`);
  }
  mkdirSync(requested, { recursive: true });
  // Vite resolves the project root through realpath (macOS tmpdir sits behind
  // /var -> /private/var), so printed paths use the same canonical form and
  // callers computing root-relative paths from them match the build's.
  const base = realpathSync(requested);
  if (readdirSync(base).length > 0) throw new UsageError(`--out directory is not empty: ${base}`);

  const workspace = join(base, basename(fixtureDir));
  cpSync(fixtureDir, workspace, {
    recursive: true,
    filter: (src) => !/[\\/](?:node_modules|dist)(?:[\\/]|$)/.test(src.slice(fixtureDir.length)),
  });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(base, "node_modules"), "dir");

  const fixtureModules = join(fixtureDir, "node_modules");
  if (existsSync(fixtureModules)) {
    mkdirSync(join(workspace, "node_modules"));
    for (const name of readdirSync(fixtureModules)) {
      if (name === ".bin" || name === ".vite") continue;
      symlinkSync(join(fixtureModules, name), join(workspace, "node_modules", name));
    }
  }
  return workspace;
}

async function buildWithVinextSource(workspace: string) {
  // vinext imports its own plugin dependencies lazily while the plugin is being
  // created, so the module runner has to stay open until the build finishes
  // (Vite's one-shot `runnerImport` closes it too early).
  const loader = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: WORKSPACE_SRC_ALIAS },
    root: REPO_ROOT,
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  const runner = createServerModuleRunner(loader.environments.ssr as RunnableDevEnvironment, {
    hmr: false,
  });
  try {
    const { default: vinext } = (await runner.import(join(VINEXT_SRC, "index.ts"))) as {
      default: (options: { appDir: string }) => PluginOption;
    };
    const builder = await createBuilder({
      root: workspace,
      configFile: false,
      plugins: [vinext({ appDir: workspace })],
      logLevel: "info",
    });
    await builder.buildApp();
  } finally {
    await runner.close();
    await loader.close();
  }
}

async function build(fixtureDir: string, out: string | undefined): Promise<BuildResult> {
  if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
    throw new UsageError(`Fixture directory not found: ${fixtureDir}`);
  }
  const workspace = prepareWorkspace(fixtureDir, out);
  await buildWithVinextSource(workspace);

  const outDir = join(workspace, "dist");
  const clientManifest = join(outDir, "client", ".vite", "manifest.json");
  if (!existsSync(clientManifest)) {
    throw new Error(`Build finished but produced no client manifest at ${clientManifest}.`);
  }
  const manifest = JSON.parse(readFileSync(clientManifest, "utf-8")) as Record<
    string,
    ManifestEntry
  >;
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry === true);
  if (!entry) throw new Error(`No entry chunk found in ${clientManifest}.`);
  return { outDir, clientManifest, entryChunk: entry.file };
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`build-fixture: ${message}\n`);
  if (!(error instanceof UsageError)) process.stderr.write(`${inspect(error)}\n`);
  process.exit(1);
}

async function runChild(): Promise<void> {
  const { fixtureDir, out } = parseCli(process.argv.slice(2));
  const result = await build(fixtureDir, out);
  process.send?.(result, () => process.exit(0));
}

function runParent(): void {
  let json: boolean;
  try {
    ({ json } = parseCli(process.argv.slice(2)));
  } catch (error) {
    fail(error);
  }

  let result: BuildResult | undefined;
  const child = spawn(
    process.execPath,
    [...process.execArgv, SCRIPT_PATH, ...process.argv.slice(2)],
    {
      env: { ...process.env, [CHILD_ENV]: "1" },
      stdio: ["inherit", 2, 2, "ipc"],
    },
  );
  child.on("message", (message) => {
    result = message as BuildResult;
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    if (code !== 0 || !result) {
      process.stderr.write(`build-fixture: build failed (${signal ?? `exit code ${code}`}).\n`);
      process.exit(code || 1);
    }
    process.stdout.write(`${json ? JSON.stringify(result) : result.outDir}\n`, () =>
      process.exit(0),
    );
  });
}

if (process.env[CHILD_ENV]) {
  runChild().catch(fail);
} else {
  runParent();
}
