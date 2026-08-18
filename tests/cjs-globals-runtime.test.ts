import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toSlash } from "pathslash";
import { createBuilder, createServer, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const CLOUDFLARE_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);
const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const NEXT_CJS_PATH_SPECIFIER = "next/dist/compiled/regenerator-runtime/path";
const NEXT_CJS_PATH_FILE = path.join(
  ROOT_NODE_MODULES,
  "next/dist/compiled/regenerator-runtime/path.js",
);
const PROJECT_IDENTITY_MARKER = "vinext-cjs-project-identity-marker";
const DEPENDENCY_IDENTITY_MARKER = "vinext-cjs-dependency-identity-marker";
const NESTED_IDENTITY_MARKER = "vinext-cjs-nested-identity-marker";
const LOCAL_IDENTITY_MARKER = "vinext-cjs-local-identity-marker";
const LINKED_IDENTITY_MARKER = "vinext-cjs-linked-identity-marker";
const SPLIT_A_IDENTITY_MARKER = "vinext-cjs-split-a-identity-marker";
const SPLIT_B_IDENTITY_MARKER = "vinext-cjs-split-b-identity-marker";
const SIBLING_RESOURCE_MARKER = "vinext-cjs-sibling-resource-marker";

function identityResourcePlugin(): Plugin {
  return {
    name: "test:emit-cjs-identity-resource",
    generateBundle() {
      if (this.environment?.config.consumer !== "server") return;
      this.emitFile({
        type: "asset",
        fileName:
          this.environment.name === "nitro"
            ? "_ssr/identity-resource.txt"
            : this.environment.name === "rsc"
              ? "_next/static/identity-resource.txt"
              : "identity-resource.txt",
        source: SIBLING_RESOURCE_MARKER,
      });
    },
  };
}

async function createHybridFixture(
  prefix: string,
  nodeModules: string,
  options: { includeApp?: boolean; nextDependencySpecifier?: string } = {},
): Promise<{
  root: string;
  canonicalRoot: string;
  cjsPackageDir: string;
  linkedCjsPackageDir: string;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(fixtureRoot, "app");
  const cjsPackageDir = path.join(root, "vendor/node_modules/cjs-path-identity");
  const linkedCjsPackageDir = path.join(fixtureRoot, "packages/linked-cjs-identity");
  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    ...(options.includeApp === false
      ? []
      : [fs.mkdir(path.join(root, "app"), { recursive: true })]),
    fs.mkdir(path.join(root, "pages"), { recursive: true }),
    fs.mkdir(path.join(root, "lib/node_modules"), { recursive: true }),
    fs.mkdir(cjsPackageDir, { recursive: true }),
    fs.mkdir(linkedCjsPackageDir, { recursive: true }),
    fs.symlink(nodeModules, path.join(root, "node_modules"), "junction"),
  ]);
  await fs.symlink(
    linkedCjsPackageDir,
    path.join(root, "lib/node_modules/linked-cjs-identity"),
    "junction",
  );
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
    ...(options.includeApp === false
      ? []
      : [
          fs.writeFile(
            path.join(root, "app/layout.tsx"),
            `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
          ),
          fs.writeFile(
            path.join(root, "app/page.tsx"),
            `import { readIdentity } from "../lib/identity";
import { IdentityView } from "../lib/identity-view";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <IdentityView props={await readIdentity()} />;
}
`,
          ),
        ]),
    fs.writeFile(
      path.join(root, "lib/identity.ts"),
      `import path from "node:path";
import regeneratorRuntimePath from ${JSON.stringify(options.nextDependencySpecifier ?? NEXT_CJS_PATH_SPECIFIER)};
import dependencyIdentity from "../vendor/node_modules/cjs-path-identity/index.js";
import localIdentity from "./local-identity.cjs";
import linkedIdentity from "linked-cjs-identity";

const projectMarker = ${JSON.stringify(PROJECT_IDENTITY_MARKER)};

export async function readIdentity() {
  const [{ default: splitA }, { default: splitB }] = await Promise.all([
    import("./split-a.cjs"),
    import("./split-b.cjs"),
  ]);
  const splitAReadSibling = splitA.readSibling(splitB.filename, splitB.marker);
  const splitBReadSibling = splitB.readSibling(splitA.filename, splitA.marker);
  return {
    runtimePath: regeneratorRuntimePath.path,
    projectRuntimePath: path.join(__dirname, "project-runtime.js"),
    dependencyRuntimePath: path.join(dependencyIdentity.dirname, "dependency-runtime.js"),
    nestedRuntimePath: path.join(dependencyIdentity.nested.dirname, "nested-runtime.js"),
    localRuntimePath: path.join(localIdentity.dirname, "local-runtime.js"),
    linkedRuntimePath: path.join(linkedIdentity.dirname, "linked-runtime.js"),
    projectMarker,
    projectFilename: __filename,
    projectDirname: __dirname,
    dependencyMarker: dependencyIdentity.marker,
    dependencyFilename: dependencyIdentity.filename,
    dependencyDirname: dependencyIdentity.dirname,
    dependencyResource: dependencyIdentity.resource,
    dependencyResourceReadable: dependencyIdentity.resourceReadable,
    dependencyResourceError: dependencyIdentity.resourceError,
    nestedMarker: dependencyIdentity.nested.marker,
    nestedFilename: dependencyIdentity.nested.filename,
    nestedDirname: dependencyIdentity.nested.dirname,
    localMarker: localIdentity.marker,
    localFilename: localIdentity.filename,
    localDirname: localIdentity.dirname,
    linkedMarker: linkedIdentity.marker,
    linkedFilename: linkedIdentity.filename,
    linkedDirname: linkedIdentity.dirname,
    splitAMarker: splitA.marker,
    splitAFilename: splitA.filename,
    splitADirname: splitA.dirname,
    splitAConsistent: splitA.consistent,
    splitAFilenameReadable: splitA.filenameReadable,
    splitBMarker: splitB.marker,
    splitBFilename: splitB.filename,
    splitBDirname: splitB.dirname,
    splitBConsistent: splitB.consistent,
    splitBFilenameReadable: splitB.filenameReadable,
    splitAReadSibling: splitAReadSibling.ok,
    splitAReadSiblingError: splitAReadSibling.error,
    splitBReadSibling: splitBReadSibling.ok,
    splitBReadSiblingError: splitBReadSibling.error,
    shadowedProcess: localIdentity.shadowedProcess,
    shadowedGlobalThis: localIdentity.shadowedGlobalThis,
    filenameReadable: localIdentity.filenameReadable,
    concatenatedPath: localIdentity.concatenatedPath,
    userMarkerTypes: localIdentity.userMarkerTypes,
    types: [
      typeof __filename,
      typeof __dirname,
      dependencyIdentity.types,
      dependencyIdentity.nested.types,
      localIdentity.types,
      linkedIdentity.types,
    ].join(","),
    consistent:
      path.dirname(__filename) === __dirname &&
      dependencyIdentity.consistent &&
      dependencyIdentity.nested.consistent &&
      localIdentity.consistent &&
      linkedIdentity.consistent,
  };
}
`,
    ),
    fs.writeFile(
      path.join(root, "lib/local-identity.cjs"),
      `const fs = require("node:fs");
const path = require("node:path");
const process = { marker: "local-process" };
const globalThis = {};
exports.marker = ${JSON.stringify(LOCAL_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
exports.shadowedProcess = process.marker;
exports.shadowedGlobalThis = Object.keys(globalThis).length === 0 ? "local-globalThis" : "wrong";
exports.concatenatedPath = __dirname + "/concatenated.js";
try {
  exports.filenameReadable = fs.statSync(__filename).isFile();
} catch {
  // Vite evaluates source modules from memory in workerd development, so the
  // host source path is identity metadata rather than a mounted virtual file.
  exports.filenameReadable = false;
}
exports.userMarkerTypes =
  typeof globalThis.__VINEXT_EMITTED_CJS_FILENAME__ + ":" +
  typeof globalThis.__VINEXT_EMITTED_CJS_DIRNAME__;
`,
    ),
    fs.writeFile(
      path.join(root, "lib/split-a.cjs"),
      `const fs = require("node:fs");
const path = require("node:path");
exports.marker = ${JSON.stringify(SPLIT_A_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
try {
  exports.filenameReadable = fs.statSync(__filename).isFile();
} catch {
  exports.filenameReadable = false;
}
exports.readSibling = (filename, marker) => {
  try {
    return { ok: fs.readFileSync(filename, "utf8").includes(marker), error: "" };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
};
`,
    ),
    fs.writeFile(
      path.join(root, "lib/split-b.cjs"),
      `const fs = require("node:fs");
const path = require("node:path");
exports.marker = ${JSON.stringify(SPLIT_B_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
try {
  exports.filenameReadable = fs.statSync(__filename).isFile();
} catch {
  exports.filenameReadable = false;
}
exports.readSibling = (filename, marker) => {
  try {
    return { ok: fs.readFileSync(filename, "utf8").includes(marker), error: "" };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
};
`,
    ),
    fs.writeFile(
      path.join(root, "lib/identity-view.tsx"),
      `import type { readIdentity } from "./identity";

export function IdentityView({ props }: {
  props: Awaited<ReturnType<typeof readIdentity>>;
}) {
  return <>
    <p id="runtime-path">{props.runtimePath}</p>
    <p id="project-runtime-path">{props.projectRuntimePath}</p>
    <p id="dependency-runtime-path">{props.dependencyRuntimePath}</p>
    <p id="nested-runtime-path">{props.nestedRuntimePath}</p>
    <p id="local-runtime-path">{props.localRuntimePath}</p>
    <p id="linked-runtime-path">{props.linkedRuntimePath}</p>
    <p id="project-marker">{props.projectMarker}</p>
    <p id="project-filename">{props.projectFilename}</p>
    <p id="project-dirname">{props.projectDirname}</p>
    <p id="dependency-marker">{props.dependencyMarker}</p>
    <p id="dependency-filename">{props.dependencyFilename}</p>
    <p id="dependency-dirname">{props.dependencyDirname}</p>
    <p id="dependency-resource">{props.dependencyResource || "none"}</p>
    <p id="dependency-resource-readable">{String(props.dependencyResourceReadable)}</p>
    <p id="dependency-resource-error">{props.dependencyResourceError || "none"}</p>
    <p id="nested-marker">{props.nestedMarker}</p>
    <p id="nested-filename">{props.nestedFilename}</p>
    <p id="nested-dirname">{props.nestedDirname}</p>
    <p id="local-marker">{props.localMarker}</p>
    <p id="local-filename">{props.localFilename}</p>
    <p id="local-dirname">{props.localDirname}</p>
    <p id="linked-marker">{props.linkedMarker}</p>
    <p id="linked-filename">{props.linkedFilename}</p>
    <p id="linked-dirname">{props.linkedDirname}</p>
    <p id="split-a-marker">{props.splitAMarker}</p>
    <p id="split-a-filename">{props.splitAFilename}</p>
    <p id="split-a-dirname">{props.splitADirname}</p>
    <p id="split-a-consistent">{String(props.splitAConsistent)}</p>
    <p id="split-a-filename-readable">{String(props.splitAFilenameReadable)}</p>
    <p id="split-b-marker">{props.splitBMarker}</p>
    <p id="split-b-filename">{props.splitBFilename}</p>
    <p id="split-b-dirname">{props.splitBDirname}</p>
    <p id="split-b-consistent">{String(props.splitBConsistent)}</p>
    <p id="split-b-filename-readable">{String(props.splitBFilenameReadable)}</p>
    <p id="split-a-read-sibling">{String(props.splitAReadSibling)}</p>
    <p id="split-a-read-sibling-error">{props.splitAReadSiblingError || "none"}</p>
    <p id="split-b-read-sibling">{String(props.splitBReadSibling)}</p>
    <p id="split-b-read-sibling-error">{props.splitBReadSiblingError || "none"}</p>
    <p id="identity-types">{props.types}</p>
    <p id="identity-consistent">{String(props.consistent)}</p>
    <p id="shadowed-process">{props.shadowedProcess}</p>
    <p id="shadowed-global-this">{props.shadowedGlobalThis}</p>
    <p id="filename-readable">{String(props.filenameReadable)}</p>
    <p id="concatenated-path">{props.concatenatedPath}</p>
    <p id="user-marker-types">{props.userMarkerTypes}</p>
  </>;
}
`,
    ),
    fs.writeFile(
      path.join(root, "pages/cjs-dependency-globals.tsx"),
      `import { readIdentity } from "../lib/identity";
import { IdentityView } from "../lib/identity-view";

export function getServerSideProps() {
  return readIdentity().then((props) => ({ props }));
}

export default function Page(props: Awaited<ReturnType<typeof readIdentity>>) {
  return <IdentityView props={props} />;
}
`,
    ),
    fs.writeFile(
      path.join(root, "pages/cjs-dependency-globals-static.tsx"),
      `import { readIdentity } from "../lib/identity";
export function getStaticProps() {
  return readIdentity().then((props) => ({ props }));
}
export { default } from "./cjs-dependency-globals";
`,
    ),
    fs.writeFile(
      path.join(cjsPackageDir, "package.json"),
      JSON.stringify({ name: "cjs-path-identity", type: "commonjs", main: "index.js" }),
    ),
    fs.writeFile(
      path.join(cjsPackageDir, "index.js"),
      `const fs = require("node:fs");
const path = require("node:path");
exports.marker = ${JSON.stringify(DEPENDENCY_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
try {
  exports.resource = fs.readFileSync(path.join(__dirname, "identity-resource.txt"), "utf8");
  exports.resourceReadable = true;
  exports.resourceError = null;
} catch (error) {
  exports.resource = null;
  exports.resourceReadable = false;
  exports.resourceError = String(error && error.message || error);
}
exports.nested = require("./nested.cjs");
`,
    ),
    fs.writeFile(path.join(cjsPackageDir, "identity-resource.txt"), SIBLING_RESOURCE_MARKER),
    fs.writeFile(
      path.join(cjsPackageDir, "nested.cjs"),
      `const path = require("node:path");
exports.marker = ${JSON.stringify(NESTED_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
`,
    ),
    fs.writeFile(
      path.join(linkedCjsPackageDir, "package.json"),
      JSON.stringify({ name: "linked-cjs-identity", type: "commonjs", main: "index.cjs" }),
    ),
    fs.writeFile(
      path.join(linkedCjsPackageDir, "index.cjs"),
      `const path = require("node:path");
exports.marker = ${JSON.stringify(LINKED_IDENTITY_MARKER)};
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
`,
    ),
    fs.writeFile(
      path.join(linkedCjsPackageDir, "client-safe.cjs"),
      `// __dirname
module.exports = { value: 1 };
`,
    ),
  ]);
  const canonicalRoot = await fs.realpath(root);
  return {
    root,
    canonicalRoot,
    cjsPackageDir: path.join(canonicalRoot, "vendor/node_modules/cjs-path-identity"),
    linkedCjsPackageDir: toSlash(await fs.realpath(linkedCjsPackageDir)),
  };
}

async function removeHybridFixture(root: string): Promise<void> {
  if (root) await fs.rm(path.dirname(root), { recursive: true, force: true });
}

async function findBuiltWorkerOutput(
  builder: Awaited<ReturnType<typeof createBuilder>>,
): Promise<string> {
  const outputDirs = new Set(
    Object.values(builder.environments).map((environment) =>
      path.resolve(builder.config.root, environment.config.build.outDir),
    ),
  );
  const workerOutputDirs: string[] = [];
  for (const outputDir of outputDirs) {
    try {
      if ((await fs.stat(path.join(outputDir, "wrangler.json"))).isFile()) {
        workerOutputDirs.push(outputDir);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (workerOutputDirs.length !== 1) {
    throw new Error(
      `Expected one built Worker output, found: ${workerOutputDirs.join(", ") || "none"}`,
    );
  }
  return fs.realpath(workerOutputDirs[0]);
}

async function includeAdditionalWorkerModules(configPath: string): Promise<void> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    find_additional_modules?: boolean;
  };
  // The synthetic package resource is deliberately unimported so the read
  // proves dirname semantics rather than Vite asset handling. Register it in
  // the exact generated no-bundle config passed to the Workerd test harness.
  config.find_additional_modules = true;
  await fs.writeFile(configPath, JSON.stringify(config));
}

async function readJavaScriptTree(root: string): Promise<string> {
  const files = await fs.readdir(root, { recursive: true });
  return (
    await Promise.all(
      files
        .filter((file) => /\.[cm]?js$/.test(file))
        .map((file) => fs.readFile(path.join(root, file), "utf8")),
    )
  ).join("\n");
}

const DIRECT_IDENTITY_FIELDS = {
  project: PROJECT_IDENTITY_MARKER,
  dependency: DEPENDENCY_IDENTITY_MARKER,
  nested: NESTED_IDENTITY_MARKER,
  local: LOCAL_IDENTITY_MARKER,
  linked: LINKED_IDENTITY_MARKER,
  "split-a": SPLIT_A_IDENTITY_MARKER,
  "split-b": SPLIT_B_IDENTITY_MARKER,
} as const;

type DirectIdentityName = keyof typeof DIRECT_IDENTITY_FIELDS;
type EmittedIdentityFiles = Record<DirectIdentityName, string[]>;

async function findEmittedIdentityFiles(root: string): Promise<EmittedIdentityFiles> {
  const files = await fs.readdir(root, { recursive: true });
  const javascriptFiles = await Promise.all(
    files
      .filter((file) => /\.[cm]?js$/.test(file))
      .map(async (file) => {
        const absolutePath = path.join(root, file);
        return {
          path: await fs.realpath(absolutePath),
          source: await fs.readFile(absolutePath, "utf8"),
        };
      }),
  );
  return Object.fromEntries(
    Object.entries(DIRECT_IDENTITY_FIELDS).map(([name, marker]) => [
      name,
      javascriptFiles.filter((file) => file.source.includes(marker)).map((file) => file.path),
    ]),
  ) as EmittedIdentityFiles;
}

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

async function waitForHttp(url: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const stoppedGracefully = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!stoppedGracefully) {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function loadCloudflarePlugin(root: string, hybrid = true): Promise<Plugin> {
  const cloudflareModule = (await import(
    pathToFileURL(path.join(root, "node_modules/@cloudflare/vite-plugin/dist/index.mjs")).href
  )) as {
    cloudflare(options?: {
      viteEnvironment: { name: string; childEnvironments: string[] };
    }): Plugin;
  };
  return hybrid
    ? cloudflareModule.cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      })
    : cloudflareModule.cloudflare();
}

function expectPathAbsent(text: string, filePath: string): void {
  expect(text).not.toContain(filePath);
  expect(toSlash(text)).not.toContain(toSlash(filePath));
}

function htmlValue(html: string, id: string): string {
  const value = html.match(new RegExp(`<p id="${id}">([^<]+)</p>`))?.[1];
  if (value === undefined) throw new Error(`Missing #${id} in rendered fixture`);
  return value;
}

function identityDirname(filename: string): string {
  return filename.startsWith("/bundle/") ? path.posix.dirname(filename) : path.dirname(filename);
}

function expectDirectModuleIdentity(
  html: string,
  options: {
    siblingReadable?: boolean;
    siblingResourceReadable?: boolean;
    splitFilenamesReadable?: boolean;
  } = {},
): Record<DirectIdentityName, string> {
  const filenames = {} as Record<DirectIdentityName, string>;
  for (const [name, marker] of Object.entries(DIRECT_IDENTITY_FIELDS) as Array<
    [DirectIdentityName, string]
  >) {
    expect(htmlValue(html, `${name}-marker`)).toBe(marker);
    const filename = htmlValue(html, `${name}-filename`);
    expect(htmlValue(html, `${name}-dirname`)).toBe(identityDirname(filename));
    filenames[name] = filename;
  }
  expect(htmlValue(html, "split-a-consistent")).toBe("true");
  expect(htmlValue(html, "split-b-consistent")).toBe("true");
  expect(filenames["split-a"]).not.toBe(filenames["split-b"]);
  if (options.splitFilenamesReadable !== undefined) {
    expect(htmlValue(html, "split-a-filename-readable")).toBe(
      String(options.splitFilenamesReadable),
    );
    expect(htmlValue(html, "split-b-filename-readable")).toBe(
      String(options.splitFilenamesReadable),
    );
  }
  if (options.siblingReadable !== undefined) {
    expect(
      htmlValue(html, "split-a-read-sibling"),
      htmlValue(html, "split-a-read-sibling-error"),
    ).toBe(String(options.siblingReadable));
    expect(
      htmlValue(html, "split-b-read-sibling"),
      htmlValue(html, "split-b-read-sibling-error"),
    ).toBe(String(options.siblingReadable));
  }
  if (options.siblingResourceReadable !== undefined) {
    expect(
      htmlValue(html, "dependency-resource-readable"),
      htmlValue(html, "dependency-resource-error"),
    ).toBe(String(options.siblingResourceReadable));
    expect(htmlValue(html, "dependency-resource")).toBe(
      options.siblingResourceReadable ? SIBLING_RESOURCE_MARKER : "none",
    );
  }
  return filenames;
}

function expectEmittedModuleIdentity(
  filenames: Record<DirectIdentityName, string>,
  emittedFiles: EmittedIdentityFiles,
  serverDir: string,
  runtime: "filesystem" | "workerd",
  scope: "all" | "rsc" | "ssr" | "nitro-ssr" = "all",
): void {
  for (const name of Object.keys(DIRECT_IDENTITY_FIELDS) as DirectIdentityName[]) {
    const scopedFiles = emittedFiles[name].filter((file) => {
      const relative = toSlash(path.relative(serverDir, file));
      if (scope === "rsc") return relative !== "ssr" && !relative.startsWith("ssr/");
      if (scope === "ssr") return relative === "ssr" || relative.startsWith("ssr/");
      if (scope === "nitro-ssr") {
        return relative === "_ssr" || relative.startsWith("_ssr/");
      }
      return true;
    });
    expect(
      scopedFiles,
      `${name} marker must exist in emitted JavaScript for ${scope}`,
    ).not.toHaveLength(0);
    const expectedFilenames = scopedFiles.flatMap((file) => {
      if (runtime === "filesystem") return [toSlash(file)];
      return [`/bundle/${toSlash(path.relative(serverDir, file))}`];
    });
    expect(
      expectedFilenames,
      `${name} runtime identity ${filenames[name]} must match one of ${expectedFilenames.join(", ")}`,
    ).toContain(toSlash(filenames[name]));
  }
}

function expectFunctionalIdentity(html: string): void {
  expect(htmlValue(html, "identity-types")).toBe(
    "string,string,string:string,string:string,string:string,string:string",
  );
  expect(htmlValue(html, "identity-consistent")).toBe("true");
  expect(htmlValue(html, "shadowed-process")).toBe("local-process");
  expect(htmlValue(html, "shadowed-global-this")).toBe("local-globalThis");
  expect(path.basename(htmlValue(html, "concatenated-path"))).toBe("concatenated.js");
  expect(htmlValue(html, "concatenated-path")).not.toContain("__VINEXT_EMITTED_CJS_");
  expect(htmlValue(html, "user-marker-types")).toBe("undefined:undefined");
  expect(path.basename(htmlValue(html, "dependency-runtime-path"))).toBe("dependency-runtime.js");
  expect(path.basename(htmlValue(html, "nested-runtime-path"))).toBe("nested-runtime.js");
  expect(path.basename(htmlValue(html, "local-runtime-path"))).toBe("local-runtime.js");
  expect(path.basename(htmlValue(html, "linked-runtime-path"))).toBe("linked-runtime.js");
}

describe("bundled CJS globals on the hybrid Node development runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let server: ViteDevServer | undefined;
  let baseUrl = "";
  let cacheDir = "";

  beforeAll(async () => {
    ({ root, canonicalRoot } = await createHybridFixture(
      "vinext-cjs-globals-node-dev-",
      ROOT_NODE_MODULES,
    ));
    await fs.writeFile(
      path.join(root, "pages/linked-cjs-client.tsx"),
      `import linked from "../lib/node_modules/linked-cjs-identity/client-safe.cjs";
export default function Page() {
  return <p id="linked-client-value">{linked.value}</p>;
}
`,
    );
    cacheDir = path.join(root, ".vite-cache");
    server = await createServer({
      root,
      cacheDir,
      configFile: false,
      plugins: [vinext({ appDir: root }), identityResourcePlugin()],
      environments: {
        rsc: { optimizeDeps: { include: [NEXT_CJS_PATH_SPECIFIER] } },
        ssr: { optimizeDeps: { include: [NEXT_CJS_PATH_SPECIFIER] } },
      },
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Hybrid Node development server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await removeHybridFixture(root);
  });

  it("uses optimizer output identity without losing unbundled project source identity", async () => {
    for (const environment of ["rsc", "ssr"] as const) {
      expect(
        server?.config.environments[environment]?.optimizeDeps?.rolldownOptions?.plugins,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "vinext:import-meta-url:optimize-deps" }),
        ]),
      );
    }
    const response = await fetch(`${baseUrl}/cjs-dependency-globals`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      `<p id="runtime-path">${path.join(cacheDir, "deps_ssr/runtime.js")}</p>`,
    );
    expect(html).toContain(
      `<p id="project-runtime-path">${path.join(canonicalRoot, "lib/project-runtime.js")}</p>`,
    );
    expect(htmlValue(html, "linked-runtime-path")).toContain(
      path.join(path.dirname(canonicalRoot), "packages/linked-cjs-identity"),
    );
    expectFunctionalIdentity(html);
    expectDirectModuleIdentity(html, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    const linkedClientResponse = await fetch(`${baseUrl}/linked-cjs-client`);
    expect(linkedClientResponse.status).toBe(200);
    expect(await linkedClientResponse.text()).toContain('<p id="linked-client-value">1</p>');
    const clientModule = await server?.environments.client.transformRequest(
      "/lib/node_modules/linked-cjs-identity/client-safe.cjs",
    );
    expect(clientModule?.code).toContain("[vite-plugin-commonjs] export-runtime-S");
    const optimizedBundle = await readJavaScriptTree(cacheDir);
    expect(optimizedBundle).toContain("import.meta.dirname");
    expect(optimizedBundle).not.toMatch(/__VINEXT_EMITTED_CJS_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);
    expect(optimizedBundle).not.toContain("var __dirname = void 0");
  });
});

describe("bundled CJS globals on the hybrid Node production runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let linkedCjsPackageDir = "";
  let server: Server | undefined;
  let baseUrl = "";
  let serverBundle = "";
  let serverDir = "";
  let emittedIdentityFiles = {} as EmittedIdentityFiles;

  beforeAll(async () => {
    ({ root, canonicalRoot, cjsPackageDir, linkedCjsPackageDir } = await createHybridFixture(
      "vinext-cjs-globals-node-prod-",
      ROOT_NODE_MODULES,
    ));
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root }), identityResourcePlugin()],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(root, "dist");
    serverDir = await fs.realpath(path.join(outDir, "server"));
    serverBundle = await readJavaScriptTree(serverDir);
    emittedIdentityFiles = await findEmittedIdentityFiles(serverDir);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({ port: 0, outDir, noCompression: true }));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Hybrid Node production server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    await closeServer(server);
    await removeHybridFixture(root);
  });

  it("uses emitted chunk identity for dependency and project modules", async () => {
    const response = await fetch(`${baseUrl}/cjs-dependency-globals`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const runtimePath = html.match(/<p id="runtime-path">([^<]+)<\/p>/)?.[1];
    expect(runtimePath).toBeDefined();
    expect(path.basename(runtimePath!)).toBe("runtime.js");
    expect(runtimePath).toContain(path.join(canonicalRoot, "dist/server"));
    expect(runtimePath).not.toContain(cjsPackageDir);
    expect(html).toContain(
      `<p id="project-runtime-path">${path.join(canonicalRoot, "dist/server/ssr/project-runtime.js")}</p>`,
    );
    expect(htmlValue(html, "dependency-runtime-path")).toContain(
      path.join(canonicalRoot, "dist/server"),
    );
    expect(htmlValue(html, "nested-runtime-path")).toContain(
      path.join(canonicalRoot, "dist/server"),
    );
    expectFunctionalIdentity(html);
    const filenames = expectDirectModuleIdentity(html, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(filenames, emittedIdentityFiles, serverDir, "filesystem", "ssr");
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expectPathAbsent(serverBundle, cjsPackageDir);
    expectPathAbsent(serverBundle, linkedCjsPackageDir);
    expect(serverBundle).not.toMatch(/__VINEXT_EMITTED_CJS_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    expect(staticResponse.status).toBe(200);
    const staticHtml = await staticResponse.text();
    expectFunctionalIdentity(staticHtml);
    const staticFilenames = expectDirectModuleIdentity(staticHtml, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(
      staticFilenames,
      emittedIdentityFiles,
      serverDir,
      "filesystem",
      "ssr",
    );
  });
});

describe("bundled CJS globals on the Cloudflare development runtime", () => {
  let root = "";
  let server: ViteDevServer | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    ({ root } = await createHybridFixture(
      "vinext-cjs-globals-worker-dev-",
      CLOUDFLARE_NODE_MODULES,
      { nextDependencySpecifier: NEXT_CJS_PATH_FILE },
    ));
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-cjs-globals-worker-dev",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
    server = await createServer({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        identityResourcePlugin(),
        await loadCloudflarePlugin(root),
      ],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Cloudflare development server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await removeHybridFixture(root);
  });

  it("executes the real CJS graph in workerd", async () => {
    const response = await fetch(`${baseUrl}/cjs-dependency-globals`);
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expectFunctionalIdentity(html);
    expectDirectModuleIdentity(html, {
      siblingReadable: false,
      siblingResourceReadable: false,
      splitFilenamesReadable: false,
    });
    expect(html).not.toMatch(/__VINEXT_EMITTED_CJS_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);
  });
});

describe("bundled CJS globals on the Cloudflare Workers runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let linkedCjsPackageDir = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";
  let workerBundle = "";
  let serverDir = "";
  let emittedIdentityFiles = {} as EmittedIdentityFiles;

  beforeAll(async () => {
    ({ root, canonicalRoot, cjsPackageDir, linkedCjsPackageDir } = await createHybridFixture(
      "vinext-cjs-globals-worker-",
      CLOUDFLARE_NODE_MODULES,
      { nextDependencySpecifier: NEXT_CJS_PATH_FILE },
    ));
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-cjs-globals-worker",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        identityResourcePlugin(),
        await loadCloudflarePlugin(root),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    serverDir = await fs.realpath(path.join(root, "dist/server"));
    workerBundle = await readJavaScriptTree(serverDir);
    emittedIdentityFiles = await findEmittedIdentityFiles(serverDir);
    const workerConfigPath = path.join(serverDir, "wrangler.json");
    await includeAdditionalWorkerModules(workerConfigPath);

    const wrangler = (await import(
      pathToFileURL(path.join(root, "node_modules/wrangler/wrangler-dist/cli.js")).href
    )) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { port: 0 };
        };
      }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
    };
    worker = await wrangler.unstable_startWorker({
      config: workerConfigPath,
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    await removeHybridFixture(root);
  });

  it("uses emitted workerd bundle identity without leaking host paths", async () => {
    const res = await fetch(`${baseUrl}/cjs-dependency-globals`);
    const html = await res.text();
    expect(res.status, html).toBe(200);
    expect(html).toContain('<p id="runtime-path">/bundle/ssr/runtime.js</p>');
    expect(html).toContain('<p id="project-runtime-path">/bundle/ssr/project-runtime.js</p>');
    expect(htmlValue(html, "dependency-runtime-path")).toBe("/bundle/ssr/dependency-runtime.js");
    expect(htmlValue(html, "nested-runtime-path")).toBe("/bundle/ssr/nested-runtime.js");
    expect(htmlValue(html, "linked-runtime-path")).toBe("/bundle/ssr/linked-runtime.js");
    expectFunctionalIdentity(html);
    const filenames = expectDirectModuleIdentity(html, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(filenames, emittedIdentityFiles, serverDir, "workerd", "ssr");
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expectPathAbsent(workerBundle, cjsPackageDir);
    expectPathAbsent(workerBundle, linkedCjsPackageDir);
    expect(workerBundle).not.toMatch(/__VINEXT_EMITTED_CJS_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);
    expectPathAbsent(html, canonicalRoot);

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    expect(staticResponse.status).toBe(200);
    const staticHtml = await staticResponse.text();
    expectFunctionalIdentity(staticHtml);
    const staticFilenames = expectDirectModuleIdentity(staticHtml, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(staticFilenames, emittedIdentityFiles, serverDir, "workerd", "ssr");

    const appResponse = await fetch(`${baseUrl}/`);
    const appHtml = await appResponse.text();
    expect(appResponse.status, appHtml).toBe(200);
    expectFunctionalIdentity(appHtml);
    const appFilenames = expectDirectModuleIdentity(appHtml, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(appFilenames, emittedIdentityFiles, serverDir, "workerd", "rsc");
  });
});

describe("bundled CJS globals on a Pages-only Cloudflare Workers runtime", () => {
  let root = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";
  let serverDir = "";
  let emittedIdentityFiles = {} as EmittedIdentityFiles;

  beforeAll(async () => {
    ({ root } = await createHybridFixture(
      "vinext-cjs-globals-pages-worker-",
      CLOUDFLARE_NODE_MODULES,
      {
        includeApp: false,
        nextDependencySpecifier: NEXT_CJS_PATH_FILE,
      },
    ));
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "vinext-cjs-globals-pages-worker",
        compatibility_date: "2026-04-01",
        compatibility_flags: ["nodejs_compat"],
        main: "vinext/server/fetch-handler",
        assets: { not_found_handling: "none", binding: "ASSETS" },
      }),
    );
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({ appDir: root }),
        identityResourcePlugin(),
        await loadCloudflarePlugin(root, false),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    serverDir = await findBuiltWorkerOutput(builder);
    emittedIdentityFiles = await findEmittedIdentityFiles(serverDir);
    const workerConfigPath = path.join(serverDir, "wrangler.json");
    await includeAdditionalWorkerModules(workerConfigPath);

    const wrangler = (await import(
      pathToFileURL(path.join(root, "node_modules/wrangler/wrangler-dist/cli.js")).href
    )) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { port: 0 };
        };
      }): Promise<{ url: Promise<URL>; dispose(): Promise<void> }>;
    };
    worker = await wrangler.unstable_startWorker({
      config: workerConfigPath,
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    await removeHybridFixture(root);
  });

  it("uses top-level emitted identities for runtime and prerendered Pages routes", async () => {
    const response = await fetch(`${baseUrl}/cjs-dependency-globals`);
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(htmlValue(html, "runtime-path")).toBe("/bundle/runtime.js");
    expect(htmlValue(html, "project-runtime-path")).toBe("/bundle/project-runtime.js");
    expectFunctionalIdentity(html);
    const filenames = expectDirectModuleIdentity(html, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(filenames, emittedIdentityFiles, serverDir, "workerd");

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    const staticHtml = await staticResponse.text();
    expect(staticResponse.status, staticHtml).toBe(200);
    expectFunctionalIdentity(staticHtml);
    const staticFilenames = expectDirectModuleIdentity(staticHtml, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(staticFilenames, emittedIdentityFiles, serverDir, "workerd");
  });
});

describe("bundled CJS globals on the Nitro Node runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let linkedCjsPackageDir = "";
  let serverProcess: ChildProcess | undefined;
  let baseUrl = "";
  let nitroBundle = "";
  let serverDir = "";
  let emittedIdentityFiles = {} as EmittedIdentityFiles;

  beforeAll(async () => {
    ({ root, canonicalRoot, cjsPackageDir, linkedCjsPackageDir } = await createHybridFixture(
      "vinext-cjs-globals-nitro-",
      NITRO_NODE_MODULES,
      { nextDependencySpecifier: NEXT_CJS_PATH_FILE },
    ));
    const nitroModule = (await import(
      pathToFileURL(path.join(root, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(): Plugin[] };
    const nitro = () => nitroModule.nitro();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root }), identityResourcePlugin(), nitro()],
      logLevel: "silent",
    });
    await builder.buildApp();

    serverDir = await fs.realpath(path.join(root, ".output/server"));
    nitroBundle = await readJavaScriptTree(serverDir);
    emittedIdentityFiles = await findEmittedIdentityFiles(serverDir);
    const port = await getAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, [path.join(serverDir, "index.mjs")], {
      cwd: root,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    await waitForHttp(`${baseUrl}/`);
  }, 180_000);

  afterAll(async () => {
    await stopChildProcess(serverProcess);
    await removeHybridFixture(root);
  });

  it("keeps chunk-relative identity through Nitro's final bundle", async () => {
    const res = await fetch(`${baseUrl}/cjs-dependency-globals`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const runtimePath = html.match(/<p id="runtime-path">([^<]+)<\/p>/)?.[1];
    expect(runtimePath).toBeDefined();
    expect(path.basename(runtimePath!)).toBe("runtime.js");
    expect(runtimePath).toContain(path.join(canonicalRoot, ".output/server"));
    expect(html).toContain(
      `<p id="project-runtime-path">${path.join(canonicalRoot, ".output/server/_ssr/project-runtime.js")}</p>`,
    );
    expect(htmlValue(html, "dependency-runtime-path")).toContain(
      path.join(canonicalRoot, ".output/server"),
    );
    expect(htmlValue(html, "nested-runtime-path")).toContain(
      path.join(canonicalRoot, ".output/server"),
    );
    expectFunctionalIdentity(html);
    const filenames = expectDirectModuleIdentity(html, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(
      filenames,
      emittedIdentityFiles,
      serverDir,
      "filesystem",
      "nitro-ssr",
    );
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expectPathAbsent(nitroBundle, cjsPackageDir);
    expectPathAbsent(nitroBundle, linkedCjsPackageDir);
    expect(nitroBundle).not.toMatch(/__VINEXT_EMITTED_CJS_(?:FILE|DIR)NAME_[a-f0-9]{32}__/);

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    expect(staticResponse.status).toBe(200);
    const staticHtml = await staticResponse.text();
    expectFunctionalIdentity(staticHtml);
    const staticFilenames = expectDirectModuleIdentity(staticHtml, {
      siblingReadable: true,
      siblingResourceReadable: true,
      splitFilenamesReadable: true,
    });
    expectEmittedModuleIdentity(
      staticFilenames,
      emittedIdentityFiles,
      serverDir,
      "filesystem",
      "nitro-ssr",
    );
  });
});
