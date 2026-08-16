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

async function createHybridFixture(
  prefix: string,
  nodeModules: string,
  options: { nextDependencySpecifier?: string } = {},
): Promise<{
  root: string;
  canonicalRoot: string;
  cjsPackageDir: string;
  esmPackageDir: string;
  linkedCjsPackageDir: string;
  lexicalCjsPackageDir: string;
  lexicalEsmPackageDir: string;
  lexicalLinkedCjsPackageDir: string;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(fixtureRoot, "app");
  const cjsPackageDir = path.join(root, "vendor/node_modules/cjs-path-identity");
  const esmPackageDir = path.join(root, "vendor/node_modules/esm-import-meta-identity");
  const linkedCjsPackageDir = path.join(fixtureRoot, "packages/linked-cjs-identity");
  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    fs.mkdir(path.join(root, "app"), { recursive: true }),
    fs.mkdir(path.join(root, "pages"), { recursive: true }),
    fs.mkdir(path.join(root, "lib/node_modules"), { recursive: true }),
    fs.mkdir(cjsPackageDir, { recursive: true }),
    fs.mkdir(esmPackageDir, { recursive: true }),
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
    fs.writeFile(
      path.join(root, "app/layout.tsx"),
      `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
    ),
    fs.writeFile(
      path.join(root, "app/page.tsx"),
      `import esmIdentity from "../vendor/node_modules/esm-import-meta-identity/index.js";

export default function Page() {
  return <>
    <p id="app-esm-url">{esmIdentity.url}</p>
    <p id="app-esm-filename">{esmIdentity.filename}</p>
    <p id="app-esm-dirname">{esmIdentity.dirname}</p>
    <p id="app-esm-consistent">{String(esmIdentity.consistent)}</p>
    <p id="app-esm-require-builtin">{String(esmIdentity.requireBuiltin)}</p>
    <p id="app-esm-require-package">{String(esmIdentity.requirePackage)}</p>
    <p id="app-esm-filename-readable">{String(esmIdentity.filenameReadable)}</p>
  </>;
}
`,
    ),
    fs.writeFile(
      path.join(root, "lib/identity.ts"),
      `import path from "node:path";
import regeneratorRuntimePath from ${JSON.stringify(options.nextDependencySpecifier ?? NEXT_CJS_PATH_SPECIFIER)};
import dependencyIdentity from "../vendor/node_modules/cjs-path-identity/index.js";
import esmIdentity from "../vendor/node_modules/esm-import-meta-identity/index.js";
import localIdentity from "./local-identity.cjs";
import linkedIdentity from "linked-cjs-identity";

export function readIdentity() {
  return {
    runtimePath: regeneratorRuntimePath.path,
    projectRuntimePath: path.join(__dirname, "project-runtime.js"),
    dependencyRuntimePath: path.join(dependencyIdentity.dirname, "dependency-runtime.js"),
    nestedRuntimePath: path.join(dependencyIdentity.nested.dirname, "nested-runtime.js"),
    localRuntimePath: path.join(localIdentity.dirname, "local-runtime.js"),
    linkedRuntimePath: path.join(linkedIdentity.dirname, "linked-runtime.js"),
    esmUrl: esmIdentity.url,
    esmFilename: esmIdentity.filename,
    esmDirname: esmIdentity.dirname,
    esmConsistent: esmIdentity.consistent,
    esmRequireBuiltin: esmIdentity.requireBuiltin,
    esmRequirePackage: esmIdentity.requirePackage,
    esmFilenameReadable: esmIdentity.filenameReadable,
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
  typeof globalThis.__VINEXT_EMITTED_MODULE_FILENAME__ + ":" +
  typeof globalThis.__VINEXT_EMITTED_MODULE_DIRNAME__ + ":" +
  typeof globalThis.__VINEXT_EMITTED_MODULE_URL__;
`,
    ),
    fs.writeFile(
      path.join(root, "pages/cjs-dependency-globals.tsx"),
      `import { readIdentity } from "../lib/identity";
export function getServerSideProps() {
  return { props: readIdentity() };
}
export default function Page(props: ReturnType<typeof readIdentity>) {
  return <>
    <p id="runtime-path">{props.runtimePath}</p>
    <p id="project-runtime-path">{props.projectRuntimePath}</p>
    <p id="dependency-runtime-path">{props.dependencyRuntimePath}</p>
    <p id="nested-runtime-path">{props.nestedRuntimePath}</p>
    <p id="local-runtime-path">{props.localRuntimePath}</p>
    <p id="linked-runtime-path">{props.linkedRuntimePath}</p>
    <p id="esm-url">{props.esmUrl}</p>
    <p id="esm-filename">{props.esmFilename}</p>
    <p id="esm-dirname">{props.esmDirname}</p>
    <p id="esm-consistent">{String(props.esmConsistent)}</p>
    <p id="esm-require-builtin">{String(props.esmRequireBuiltin)}</p>
    <p id="esm-require-package">{String(props.esmRequirePackage)}</p>
    <p id="esm-filename-readable">{String(props.esmFilenameReadable)}</p>
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
      path.join(root, "pages/cjs-dependency-globals-static.tsx"),
      `import { readIdentity } from "../lib/identity";
export function getStaticProps() {
  return { props: readIdentity() };
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
      `const path = require("node:path");
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
exports.nested = require("./nested.cjs");
`,
    ),
    fs.writeFile(
      path.join(cjsPackageDir, "nested.cjs"),
      `const path = require("node:path");
exports.filename = __filename;
exports.dirname = __dirname;
exports.types = typeof __filename + ":" + typeof __dirname;
exports.consistent = path.dirname(__filename) === __dirname;
`,
    ),
    fs.writeFile(
      path.join(esmPackageDir, "package.json"),
      JSON.stringify({ name: "esm-import-meta-identity", type: "module", main: "index.js" }),
    ),
    fs.writeFile(
      path.join(esmPackageDir, "index.js"),
      // Mirrors Payload's top-level ESM initialization patterns:
      // https://github.com/payloadcms/payload/blob/main/packages/payload/src/index.ts
      // https://github.com/payloadcms/payload/blob/main/packages/drizzle/src/sqlite/requireDrizzleKit.ts
      `import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const url = import.meta.url;
const filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
let filenameReadable = false;
let requirePackage = false;
try {
  filenameReadable = fs.statSync(filename).isFile();
} catch {}
try {
  // Payload later uses this require for drizzle-kit/api. Node-based runtimes
  // retain a package tree, so exercise package-relative resolution there too.
  requirePackage = typeof require("react").createElement === "function";
} catch {}

export default {
  url,
  filename,
  dirname: path.dirname(filename),
  consistent: path.dirname(fileURLToPath(url)) === path.dirname(filename),
  requireBuiltin: typeof require("node:path").join === "function",
  requirePackage,
  filenameReadable,
};
`,
    ),
    fs.writeFile(
      path.join(linkedCjsPackageDir, "package.json"),
      JSON.stringify({ name: "linked-cjs-identity", type: "commonjs", main: "index.cjs" }),
    ),
    fs.writeFile(
      path.join(linkedCjsPackageDir, "index.cjs"),
      `const path = require("node:path");
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
    esmPackageDir: path.join(canonicalRoot, "vendor/node_modules/esm-import-meta-identity"),
    linkedCjsPackageDir: toSlash(await fs.realpath(linkedCjsPackageDir)),
    lexicalCjsPackageDir: cjsPackageDir,
    lexicalEsmPackageDir: esmPackageDir,
    lexicalLinkedCjsPackageDir: linkedCjsPackageDir,
  };
}

async function removeHybridFixture(root: string): Promise<void> {
  if (root) await fs.rm(path.dirname(root), { recursive: true, force: true });
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

async function loadCloudflarePlugin(root: string): Promise<Plugin> {
  const cloudflareModule = (await import(
    pathToFileURL(path.join(root, "node_modules/@cloudflare/vite-plugin/dist/index.mjs")).href
  )) as {
    cloudflare(options: { viteEnvironment: { name: string; childEnvironments: string[] } }): Plugin;
  };
  return cloudflareModule.cloudflare({
    viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
  });
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

function expectFunctionalIdentity(html: string, options: { requirePackage?: boolean } = {}): void {
  expect(htmlValue(html, "identity-types")).toBe(
    "string,string,string:string,string:string,string:string,string:string",
  );
  expect(htmlValue(html, "identity-consistent")).toBe("true");
  expect(htmlValue(html, "shadowed-process")).toBe("local-process");
  expect(htmlValue(html, "shadowed-global-this")).toBe("local-globalThis");
  expect(path.basename(htmlValue(html, "concatenated-path"))).toBe("concatenated.js");
  expect(htmlValue(html, "concatenated-path")).not.toContain("__VINEXT_EMITTED_MODULE_");
  expect(htmlValue(html, "user-marker-types")).toBe("undefined:undefined:undefined");
  expect(path.basename(htmlValue(html, "dependency-runtime-path"))).toBe("dependency-runtime.js");
  expect(path.basename(htmlValue(html, "nested-runtime-path"))).toBe("nested-runtime.js");
  expect(path.basename(htmlValue(html, "local-runtime-path"))).toBe("local-runtime.js");
  expect(path.basename(htmlValue(html, "linked-runtime-path"))).toBe("linked-runtime.js");
  const esmUrl = htmlValue(html, "esm-url");
  const esmFilename = htmlValue(html, "esm-filename");
  expect(esmUrl).toBe(pathToFileURL(esmFilename).href);
  expect(esmFilename).not.toBe("/");
  expect(htmlValue(html, "esm-dirname")).toBe(path.dirname(esmFilename));
  expect(htmlValue(html, "esm-consistent")).toBe("true");
  expect(htmlValue(html, "esm-require-builtin")).toBe("true");
  if (options.requirePackage !== undefined) {
    expect(htmlValue(html, "esm-require-package")).toBe(String(options.requirePackage));
  }
}

function expectAppEsmIdentity(
  html: string,
  options: { requirePackage?: boolean } = {},
): { filename: string; readable: string } {
  const url = htmlValue(html, "app-esm-url");
  const filename = htmlValue(html, "app-esm-filename");
  expect(url).toBe(pathToFileURL(filename).href);
  expect(filename).not.toBe("/");
  expect(htmlValue(html, "app-esm-dirname")).toBe(path.dirname(filename));
  expect(htmlValue(html, "app-esm-consistent")).toBe("true");
  expect(htmlValue(html, "app-esm-require-builtin")).toBe("true");
  if (options.requirePackage !== undefined) {
    expect(htmlValue(html, "app-esm-require-package")).toBe(String(options.requirePackage));
  }
  return { filename, readable: htmlValue(html, "app-esm-filename-readable") };
}

describe("bundled module identity on the hybrid Node development runtime", () => {
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
      plugins: [vinext({ appDir: root })],
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
    expectFunctionalIdentity(html, { requirePackage: true });
    expect(htmlValue(html, "esm-filename")).toContain(
      path.join(canonicalRoot, "vendor/node_modules/esm-import-meta-identity/index.js"),
    );
    expect(htmlValue(html, "esm-filename-readable")).toBe("true");
    const appResponse = await fetch(`${baseUrl}/`);
    expect(appResponse.status).toBe(200);
    const appIdentity = expectAppEsmIdentity(await appResponse.text(), { requirePackage: true });
    expect(appIdentity.filename).toContain(
      path.join(canonicalRoot, "vendor/node_modules/esm-import-meta-identity/index.js"),
    );
    expect(appIdentity.readable).toBe("true");
    const linkedClientResponse = await fetch(`${baseUrl}/linked-cjs-client`);
    expect(linkedClientResponse.status).toBe(200);
    expect(await linkedClientResponse.text()).toContain('<p id="linked-client-value">1</p>');
    const clientModule = await server?.environments.client.transformRequest(
      "/lib/node_modules/linked-cjs-identity/client-safe.cjs",
    );
    expect(clientModule?.code).toContain("[vite-plugin-commonjs] export-runtime-S");
    const optimizedBundle = await readJavaScriptTree(cacheDir);
    expect(optimizedBundle).toContain("import.meta.dirname");
    expect(optimizedBundle).not.toMatch(
      /__VINEXT_EMITTED_MODULE_(?:(?:FILE|DIR)NAME|URL)_[a-f0-9]{32}__/,
    );
    expect(optimizedBundle).not.toContain("var __dirname = void 0");
  });
});

describe("bundled module identity on the hybrid Node production runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let esmPackageDir = "";
  let linkedCjsPackageDir = "";
  let lexicalCjsPackageDir = "";
  let lexicalEsmPackageDir = "";
  let lexicalLinkedCjsPackageDir = "";
  let server: Server | undefined;
  let baseUrl = "";
  let serverBundle = "";

  beforeAll(async () => {
    ({
      root,
      canonicalRoot,
      cjsPackageDir,
      esmPackageDir,
      linkedCjsPackageDir,
      lexicalCjsPackageDir,
      lexicalEsmPackageDir,
      lexicalLinkedCjsPackageDir,
    } = await createHybridFixture("vinext-cjs-globals-node-prod-", ROOT_NODE_MODULES));
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(root, "dist");
    serverBundle = await readJavaScriptTree(path.join(outDir, "server"));
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
    expectFunctionalIdentity(html, { requirePackage: true });
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expect(htmlValue(html, "esm-filename")).toContain(path.join(canonicalRoot, "dist/server"));
    expect(htmlValue(html, "esm-filename-readable")).toBe("true");
    expectPathAbsent(serverBundle, cjsPackageDir);
    expectPathAbsent(serverBundle, esmPackageDir);
    expectPathAbsent(serverBundle, linkedCjsPackageDir);
    expectPathAbsent(serverBundle, lexicalCjsPackageDir);
    expectPathAbsent(serverBundle, lexicalEsmPackageDir);
    expectPathAbsent(serverBundle, lexicalLinkedCjsPackageDir);
    expect(serverBundle).not.toMatch(
      /__VINEXT_EMITTED_MODULE_(?:(?:FILE|DIR)NAME|URL)_[a-f0-9]{32}__/,
    );

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    expect(staticResponse.status).toBe(200);
    expectFunctionalIdentity(await staticResponse.text(), { requirePackage: true });

    const appResponse = await fetch(`${baseUrl}/`);
    expect(appResponse.status).toBe(200);
    const appIdentity = expectAppEsmIdentity(await appResponse.text(), { requirePackage: true });
    expect(appIdentity.filename).toContain(path.join(canonicalRoot, "dist/server"));
    expect(appIdentity.readable).toBe("true");
  });
});

describe("bundled module identity on the Cloudflare development runtime", () => {
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
      plugins: [vinext({ appDir: root }), await loadCloudflarePlugin(root)],
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

  it("executes the real CJS and ESM graphs in workerd", async () => {
    const response = await fetch(`${baseUrl}/cjs-dependency-globals`);
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expectFunctionalIdentity(html);
    expect(path.basename(htmlValue(html, "esm-filename"))).toMatch(/\.js$/);
    expect(htmlValue(html, "esm-filename-readable")).toBe("false");
    expect(html).not.toMatch(/__VINEXT_EMITTED_MODULE_(?:(?:FILE|DIR)NAME|URL)_[a-f0-9]{32}__/);

    const appResponse = await fetch(`${baseUrl}/`);
    const appHtml = await appResponse.text();
    expect(appResponse.status, appHtml).toBe(200);
    const appIdentity = expectAppEsmIdentity(appHtml);
    expect(path.basename(appIdentity.filename)).toMatch(/\.js$/);
    expect(appIdentity.readable).toBe("false");
  });
});

describe("bundled module identity on the Cloudflare Workers runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let esmPackageDir = "";
  let linkedCjsPackageDir = "";
  let lexicalCjsPackageDir = "";
  let lexicalEsmPackageDir = "";
  let lexicalLinkedCjsPackageDir = "";
  let worker: { url: Promise<URL>; dispose(): Promise<void> } | undefined;
  let baseUrl = "";
  let workerBundle = "";

  beforeAll(async () => {
    ({
      root,
      canonicalRoot,
      cjsPackageDir,
      esmPackageDir,
      linkedCjsPackageDir,
      lexicalCjsPackageDir,
      lexicalEsmPackageDir,
      lexicalLinkedCjsPackageDir,
    } = await createHybridFixture("vinext-cjs-globals-worker-", CLOUDFLARE_NODE_MODULES, {
      nextDependencySpecifier: NEXT_CJS_PATH_FILE,
    }));
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
      plugins: [vinext({ appDir: root }), await loadCloudflarePlugin(root)],
      logLevel: "silent",
    });
    await builder.buildApp();
    workerBundle = await readJavaScriptTree(path.join(root, "dist/server"));

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
      config: path.join(root, "dist/server/wrangler.json"),
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
    expect(html).toContain('<p id="runtime-path">/bundle/runtime.js</p>');
    expect(html).toContain('<p id="project-runtime-path">/bundle/project-runtime.js</p>');
    expect(htmlValue(html, "dependency-runtime-path")).toBe("/bundle/dependency-runtime.js");
    expect(htmlValue(html, "nested-runtime-path")).toBe("/bundle/nested-runtime.js");
    expect(htmlValue(html, "linked-runtime-path")).toBe("/bundle/linked-runtime.js");
    expectFunctionalIdentity(html);
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expect(htmlValue(html, "esm-filename")).toMatch(/^\/bundle\/.+\.js$/);
    expect(htmlValue(html, "esm-filename-readable")).toBe("true");
    expectPathAbsent(workerBundle, cjsPackageDir);
    expectPathAbsent(workerBundle, esmPackageDir);
    expectPathAbsent(workerBundle, linkedCjsPackageDir);
    expectPathAbsent(workerBundle, lexicalCjsPackageDir);
    expectPathAbsent(workerBundle, lexicalEsmPackageDir);
    expectPathAbsent(workerBundle, lexicalLinkedCjsPackageDir);
    expect(workerBundle).not.toMatch(
      /__VINEXT_EMITTED_MODULE_(?:(?:FILE|DIR)NAME|URL)_[a-f0-9]{32}__/,
    );
    expectPathAbsent(html, canonicalRoot);
    expectPathAbsent(html, root);

    const staticResponse = await fetch(`${baseUrl}/cjs-dependency-globals-static`);
    expect(staticResponse.status).toBe(200);
    expectFunctionalIdentity(await staticResponse.text());

    const appResponse = await fetch(`${baseUrl}/`);
    const appHtml = await appResponse.text();
    expect(appResponse.status, appHtml).toBe(200);
    const appIdentity = expectAppEsmIdentity(appHtml);
    expect(appIdentity.filename).toMatch(/^\/bundle\/.+\.js$/);
    expect(appIdentity.readable).toBe("true");
    expectPathAbsent(appHtml, canonicalRoot);
    expectPathAbsent(appHtml, root);
  });
});

describe("bundled module identity on the Nitro Node runtime", () => {
  let root = "";
  let canonicalRoot = "";
  let cjsPackageDir = "";
  let esmPackageDir = "";
  let linkedCjsPackageDir = "";
  let lexicalCjsPackageDir = "";
  let lexicalEsmPackageDir = "";
  let lexicalLinkedCjsPackageDir = "";
  let serverProcess: ChildProcess | undefined;
  let baseUrl = "";
  let nitroBundle = "";

  beforeAll(async () => {
    ({
      root,
      canonicalRoot,
      cjsPackageDir,
      esmPackageDir,
      linkedCjsPackageDir,
      lexicalCjsPackageDir,
      lexicalEsmPackageDir,
      lexicalLinkedCjsPackageDir,
    } = await createHybridFixture("vinext-cjs-globals-nitro-", NITRO_NODE_MODULES, {
      nextDependencySpecifier: NEXT_CJS_PATH_FILE,
    }));
    const nitroModule = (await import(
      pathToFileURL(path.join(root, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(): Plugin[] };
    const nitro = () => nitroModule.nitro();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root }), nitro()],
      logLevel: "silent",
    });
    await builder.buildApp();

    const serverDir = path.join(root, ".output/server");
    nitroBundle = await readJavaScriptTree(serverDir);
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
    expectFunctionalIdentity(html, { requirePackage: true });
    expect(htmlValue(html, "filename-readable")).toBe("true");
    expect(htmlValue(html, "esm-filename")).toContain(path.join(canonicalRoot, ".output/server"));
    expect(htmlValue(html, "esm-filename-readable")).toBe("true");
    expectPathAbsent(nitroBundle, cjsPackageDir);
    expectPathAbsent(nitroBundle, esmPackageDir);
    expectPathAbsent(nitroBundle, linkedCjsPackageDir);
    expectPathAbsent(nitroBundle, lexicalCjsPackageDir);
    expectPathAbsent(nitroBundle, lexicalEsmPackageDir);
    expectPathAbsent(nitroBundle, lexicalLinkedCjsPackageDir);
    expect(nitroBundle).not.toMatch(
      /__VINEXT_EMITTED_MODULE_(?:(?:FILE|DIR)NAME|URL)_[a-f0-9]{32}__/,
    );

    const appResponse = await fetch(`${baseUrl}/`);
    expect(appResponse.status).toBe(200);
    const appIdentity = expectAppEsmIdentity(await appResponse.text(), { requirePackage: true });
    expect(appIdentity.filename).toContain(path.join(canonicalRoot, ".output/server"));
    expect(appIdentity.readable).toBe("true");
  });
});
