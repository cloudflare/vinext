import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
}

async function writePackage(
  root: string,
  name: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = { main: "index.js" },
): Promise<void> {
  const dir = path.join(root, "node_modules", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), content);
  }
}

const exportValue = (value: string) => ({
  "index.js": `module.exports = { value: "${value}" };\n`,
});

// `require()` resolves the `require` condition, not `import`.
const writeDualPackage = (root: string, name: string) =>
  writePackage(
    root,
    name,
    {
      "lib/index.mjs": `export const value = "${name} esm";\n`,
      "lib/index.cjs": `exports.value = "${name} cjs";\n`,
    },
    { exports: { ".": { import: "./lib/index.mjs", require: "./lib/index.cjs" } } },
  );

type Router = "app" | "pages";

const ROUTES: Record<Router, [file: string, code: string]> = {
  app: [
    "app/api/legacy/route.ts",
    `import legacy from "../../../lib/legacy.cjs";
import cjsLib from "cjs-lib";
import imported from "imported-ext";
import { label, used } from "../../../lib/dead.mjs";
import { shadowed } from "../../../lib/shadow.mjs";
import { value } from "esm-lib";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ values: [...legacy(), ...value(), cjsLib.resolved, cjsLib.created, shadowed, imported.value, used, label] });
}
`,
  ],
  pages: [
    "pages/api/legacy.ts",
    `import legacy from "../../lib/legacy.cjs";
import cjsLib from "cjs-lib";
import imported from "imported-ext";
import { label, used } from "../../lib/dead.mjs";
import { shadowed } from "../../lib/shadow.mjs";
import { value } from "esm-lib";
export default function handler(req, res) {
  res.status(200).json({ values: [...legacy(), ...value(), cjsLib.resolved, cjsLib.created, shadowed, imported.value, used, label] });
}
`,
  ],
};

async function createApp(router: Router): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-nitro-externals-${router}-`));
  await fs.mkdir(path.join(root, "node_modules"));
  for (const entry of await fs.readdir(NITRO_NODE_MODULES)) {
    // Skip build dirs such as `.nitro`, so each build writes into the temp app.
    if (entry.startsWith(".")) continue;
    await fs.symlink(
      path.join(NITRO_NODE_MODULES, entry),
      path.join(root, "node_modules", entry),
      "junction",
    );
  }
  const [routeFile, routeCode] = ROUTES[router];
  await Promise.all([
    writePackage(root, "required-ext", exportValue("required-ext loaded")),
    writePackage(root, "unused-ext", exportValue("unused-ext loaded")),
    writePackage(root, "created-ext", exportValue("created-ext loaded")),
    writePackage(root, "dead-ext", exportValue("dead-ext loaded")),
    writePackage(root, "fake-ext", exportValue("fake-ext loaded")),
    writePackage(root, "resolved-ext", exportValue("resolved-ext loaded")),
    writePackage(root, "imported-ext", exportValue("imported-ext loaded")),
    writePackage(root, "cjs-created-ext", exportValue("cjs-created-ext loaded")),
    writePackage(root, "cjs-lib-created-ext", exportValue("cjs-lib-created-ext loaded")),
    writePackage(root, "shadowed-ext", exportValue("shadowed-ext loaded")),
    writePackage(root, "shadowed-load-ext", exportValue("shadowed-load-ext loaded")),
    writePackage(root, "resolved-lib-ext", exportValue("resolved-lib-ext loaded")),
    writePackage(root, "resolved-created-ext", exportValue("resolved-created-ext loaded")),
    // Kept out of tracing by the build's `traceDeps` and `noExternals` opt-outs.
    writePackage(root, "optout-ext", exportValue("optout-ext loaded")),
    writePackage(root, "bundled-ext", exportValue("bundled-ext loaded")),
    // A linked workspace package, which Nitro doesn't trace.
    fs
      .mkdir(path.join(root, "vendor/linked-ext"), { recursive: true })
      .then(() =>
        Promise.all([
          fs.writeFile(
            path.join(root, "vendor/linked-ext/package.json"),
            JSON.stringify({ name: "linked-ext", main: "index.js" }),
          ),
          fs.writeFile(
            path.join(root, "vendor/linked-ext/index.js"),
            `module.exports = { value: "linked-ext module" };\n`,
          ),
          fs.symlink(
            "../vendor/linked-ext",
            path.join(root, "node_modules/linked-ext"),
            "junction",
          ),
        ]),
      ),
    // A CommonJS dependency, which Nitro bundles for the App Router.
    writePackage(root, "cjs-lib", {
      "index.js": `let resolved = "resolved-lib-ext missing";
try {
  require("fs").readFileSync(require.resolve("resolved-lib-ext"));
  resolved = "resolved-lib-ext resolved";
} catch {}
exports.resolved = resolved;
exports.created = require("node:module").createRequire(__filename)("cjs-lib-created-ext").value;
`,
    }),
    writeDualPackage(root, "dual-ext"),
    // Subpaths of packages without `exports`, required without their extension.
    writePackage(root, "deep-ext", {
      ...exportValue("deep-ext index"),
      "feature.js": `module.exports = { value: "deep-ext feature" };\n`,
    }),
    writePackage(root, "deep-created-ext", {
      ...exportValue("deep-created-ext index"),
      "feature.js": `module.exports = { value: "deep-created-ext feature" };\n`,
    }),
    writeDualPackage(root, "created-dual-ext"),
    // An ESM dependency that loads externals with `createRequire`. The Pages
    // Router server environment bundles it; for the App Router, Nitro does.
    writePackage(
      root,
      "esm-lib",
      {
        // A local `require` binding, which a marker must not call.
        "index.js": `import { createRequire as makeRequire } from "node:module";
const require = makeRequire(import.meta.url);
let nested = "nested-ext missing";
try {
  nested = require("nested-ext").value;
} catch {}
export const value = () => [
  require?.("created-ext").value,
  require("created-dual-ext").value,
  require("deep-created-ext/feature").value,
  require.resolve?.("resolved-created-ext") ? "resolved-created-ext resolved" : "",
  nested,
];
`,
        // Only `esm-lib` resolves this copy. Nitro traces it when it bundles
        // `esm-lib`; vinext's bundled `createRequire` can't load it.
        "node_modules/nested-ext/package.json": JSON.stringify({ name: "nested-ext" }),
        "node_modules/nested-ext/index.js": `module.exports = { value: "nested-ext loaded" };\n`,
      },
      { type: "module", exports: "./index.js" },
    ),
    fs.mkdir(path.join(root, "lib")),
    fs.mkdir(path.join(root, path.dirname(routeFile)), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), `{ "type": "module" }`),
    fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  serverExternalPackages: [
    "required-ext",
    "unused-ext",
    "created-ext",
    "created-dual-ext",
    "dead-ext",
    "deep-created-ext",
    "deep-ext",
    "dual-ext",
    "fake-ext",
    "missing-ext",
    "nested-ext",
    "resolved-ext",
    "resolved-lib-ext",
    "resolved-created-ext",
    "imported-ext",
    "cjs-created-ext",
    "cjs-lib-created-ext",
    "shadowed-ext",
    "shadowed-load-ext",
    "optout-ext",
    "bundled-ext",
    "linked-ext",
  ],
};
`,
    ),
    // Bundled CommonJS, so the server output calls `createRequire(...)`
    // instead of importing these packages.
    fs.writeFile(
      path.join(root, "lib/legacy.cjs"),
      `let optional = "missing";
try {
  optional = require("missing-ext").value;
} catch {}
let optedOut = "optout-ext missing";
try {
  optedOut = require("optout-ext").value;
} catch {}
let bundled = "bundled-ext missing";
try {
  bundled = require("bundled-ext").value;
} catch {}
let linked = "linked-ext missing";
try {
  require("linked-ext");
  linked = "linked-ext loaded";
} catch {}
const { createRequire } = require("node:module");
const load = createRequire(__filename);
module.exports = () => [
  require("required-ext").value,
  require("dual-ext").value,
  require("deep-ext/feature").value,
  require("fs").existsSync(require.resolve("resolved-ext")) ? "resolved-ext resolved" : "",
  load("cjs-created-ext").value,
  optional,
  optedOut,
  bundled,
  linked,
];
`,
    ),
    // Tree-shaking drops `unused`, so `dead-ext` is never loaded, though its
    // name survives. `fake-ext` is passed to a `createRequire` that isn't Node's.
    fs.writeFile(
      path.join(root, "lib/dead.mjs"),
      `import { createRequire } from "node:module";
export function unused() {
  return createRequire(import.meta.url)("dead-ext").value;
}
export const label = "dead-ext";
const helpers = { createRequire: () => (name) => name };
export const used = helpers.createRequire()("fake-ext") === "fake-ext" ? "used" : "unused";
`,
    ),
    // Locals that shadow Node's `createRequire` and a `require` made with it.
    fs.writeFile(
      path.join(root, "lib/shadow.mjs"),
      `import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
function viaParam(createRequire) {
  return createRequire()("shadowed-ext");
}
function viaLocal(load) {
  return load("shadowed-load-ext");
}
export const shadowed = [viaParam(() => (name) => name), viaLocal((name) => name), typeof load].join();
`,
    ),
    fs.writeFile(path.join(root, routeFile), routeCode),
    router === "app"
      ? fs.writeFile(
          path.join(root, "app/layout.tsx"),
          `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
        )
      : undefined,
  ]);
  return root;
}

type TraceDep = string | RegExp;

// Builds the app and returns the `traceDeps` Nitro reads to bundle the server.
async function buildWithNitro(root: string, config: Record<string, unknown>): Promise<TraceDep[]> {
  const nitroModule = (await import(
    pathToFileURL(path.join(root, "node_modules/nitro/dist/vite.mjs")).href
  )) as { nitro(config?: Record<string, unknown>): Plugin[] };
  let traceDeps: TraceDep[] = [];
  const captureTraceDeps = {
    setup(nitro: {
      options: { traceDeps?: TraceDep[] };
      hooks: { hook(name: string, fn: () => void): void };
    }) {
      // Called right after `build:before`, when Nitro reads `traceDeps`.
      nitro.hooks.hook("rollup:before", () => {
        traceDeps = [...(nitro.options.traceDeps ?? [])];
      });
    },
  };
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      vinext({ appDir: root }),
      nitroModule.nitro({ ...config, modules: [captureTraceDeps] }),
    ],
    // Keep bundled bindings such as a local `require` under their own names.
    build: { minify: false },
  });
  await builder.buildApp();
  return traceDeps;
}

async function readJavaScript(dirs: string[]): Promise<string> {
  const contents: string[] = [];
  for (const dir of dirs) {
    for (const file of await fs.readdir(dir, { recursive: true })) {
      if (/\.m?js$/.test(file)) contents.push(await fs.readFile(path.join(dir, file), "utf8"));
    }
  }
  return contents.join("\n");
}

type OutputServer = {
  outputRoot: string;
  baseUrl: string;
  server: ChildProcess;
  stderr: () => string;
};

// Runs the Nitro output without the project, as on a deployment host.
async function serveOutput(root: string): Promise<OutputServer> {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-externals-output-"));
  await fs.cp(path.join(root, ".output"), path.join(outputRoot, ".output"), { recursive: true });
  await fs.rm(root, { recursive: true, force: true });
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(outputRoot, ".output/server/index.mjs")], {
    cwd: outputRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr!.on("data", (chunk) => (stderr += chunk));
  await waitForServer(`${baseUrl}/api/legacy`);
  return { outputRoot, baseUrl, server, stderr: () => stderr };
}

// Next.js output file tracing copies the externals the server imports or
// `require()`s, and nothing else.
describe.each(["pages", "app"] as const)("Nitro output server externals (%s router)", (router) => {
  let root = "";
  let output: OutputServer | undefined;
  let workerOutput = "";
  let serverOutput = "";
  let traceDeps: TraceDep[] = [];

  beforeAll(async () => {
    root = await createApp(router);
    traceDeps = await buildWithNitro(root, {
      traceDeps: ["!optout-ext"],
      noExternals: ["node_modules/bundled-ext/"],
    });
    serverOutput = await readJavaScript([path.join(root, ".output/server")]);
    // Nitro bundles every dependency for a Worker, so nothing is traced. Its
    // prerenderer re-runs module setup with a Node preset mid-build.
    await buildWithNitro(root, {
      buildDir: path.join(root, ".nitro-worker"),
      output: { dir: path.join(root, ".output-worker") },
      preset: "cloudflare_module",
      prerender: { routes: ["/api/legacy"] },
    });
    workerOutput = await readJavaScript([
      path.join(root, ".nitro-worker/vite/services"),
      path.join(root, ".output-worker/server"),
    ]);
    output = await serveOutput(root);
  }, 180_000);

  afterAll(async () => {
    await stopServer(output?.server);
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (output) await fs.rm(output.outputRoot, { recursive: true, force: true });
  });

  it("copies the server externals the server loads through require()", async () => {
    const response = await fetch(`${output!.baseUrl}/api/legacy`);
    expect(response.status, output!.stderr()).toBe(200);
    expect(await response.json()).toEqual({
      values: [
        "required-ext loaded",
        "dual-ext cjs",
        "deep-ext feature",
        "resolved-ext resolved",
        "cjs-created-ext loaded",
        "missing",
        "optout-ext missing",
        "bundled-ext missing",
        // The App Router server environment bundles a linked package.
        router === "app" ? "linked-ext loaded" : "linked-ext missing",
        "created-ext loaded",
        "created-dual-ext cjs",
        "deep-created-ext feature",
        "resolved-created-ext resolved",
        router === "app" ? "nested-ext loaded" : "nested-ext missing",
        "resolved-lib-ext resolved",
        "cjs-lib-created-ext loaded",
        "shadowed-ext,shadowed-load-ext,function",
        "imported-ext loaded",
        "used",
        "dead-ext",
      ],
    });
  });

  // Nitro force-copies string `traceDeps` entries only from 3.0.260903-beta, so
  // on the repo's Nitro this guards the `require()` marking; nitro-setup.test.ts
  // checks that server externals never become string entries.
  it("does not copy a server external the server never loads", async () => {
    const copied = await fs.readdir(path.join(output!.outputRoot, ".output/server/node_modules"));
    expect(copied).toEqual(
      expect.arrayContaining([
        "cjs-created-ext",
        "cjs-lib-created-ext",
        "created-dual-ext",
        "created-ext",
        "deep-created-ext",
        "deep-ext",
        "dual-ext",
        "imported-ext",
        "required-ext",
        "resolved-created-ext",
        "resolved-ext",
        "resolved-lib-ext",
      ]),
    );
    expect(copied).not.toContain("unused-ext");
    expect(copied).not.toContain("dead-ext");
    expect(copied).not.toContain("fake-ext");
    expect(copied).not.toContain("shadowed-ext");
    expect(copied).not.toContain("shadowed-load-ext");
  });

  // Nitro force-copies string entries from 3.0.260903-beta (nitrojs/nitro#4391).
  it("gives Nitro the server externals as exact-name patterns, not names to copy", () => {
    expect(traceDeps.filter((dep) => typeof dep === "string")).toEqual(["!optout-ext"]);
    const patterns = traceDeps.filter((dep): dep is RegExp => dep instanceof RegExp);
    expect(patterns.some((dep) => dep.test("unused-ext"))).toBe(true);
    expect(patterns.some((dep) => dep.test("typescript"))).toBe(true);
  });

  // A marker would make Nitro bundle these into a branch that never runs. As
  // before, the server can't load them.
  it("does not mark a server external Nitro keeps out of tracing", async () => {
    const copied = await fs.readdir(path.join(output!.outputRoot, ".output/server/node_modules"));
    expect(copied).not.toContain("optout-ext");
    expect(copied).not.toContain("bundled-ext");
    expect(serverOutput.includes("optout-ext loaded")).toBe(false);
    expect(serverOutput.includes("bundled-ext loaded")).toBe(false);
    if (router === "pages") expect(serverOutput.includes("linked-ext module")).toBe(false);
  });

  it("does not mark require()d externals for a Nitro preset that bundles them", () => {
    expect(workerOutput.includes("required-ext")).toBe(true);
    expect(workerOutput.includes("__VINEXT_NITRO_TRACE_ONLY__")).toBe(false);
  });
});
