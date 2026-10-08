import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// Builds the standalone-output fixture inside a monorepo layout where a
// workspace package installs different versions of shared dependencies in its
// own node_modules, then starts dist/standalone/server.js from an isolated
// directory (as the standalone-output e2e project does) so nothing can resolve
// from the workspace. Covers https://github.com/cloudflare/vinext/issues/3443.

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/standalone-output");
const FIXTURE_NODE_MODULES = path.join(FIXTURE_DIR, "node_modules");
const NESTED_REACT_VERSION = "19.2.5";

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

function writeDepX(packageRoot: string, version: string, exportName: string): void {
  writeFile(
    packageRoot,
    "package.json",
    JSON.stringify({ name: "dep-x", version, type: "module", main: "index.js" }),
  );
  writeFile(packageRoot, "index.js", `export const ${exportName} = "dep-x v${version}";\n`);
}

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version: string }).version;
}

/**
 * Lay out a monorepo with the fixture as `apps/web` and a `packages/ws-ui`
 * workspace package. The app installs the workspace's real react and
 * `dep-x@1.0.0` (which the server never imports). ws-ui pins its own
 * react@19.2.5 and needs `dep-x@2.0.0`, both installed in ws-ui's own
 * node_modules. The pinned react is a stub that throws when loaded.
 */
function createMonorepo(nextConfig: Record<string, unknown>): { tmpDir: string; appRoot: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-standalone-workspace-"));
  const appRoot = path.join(tmpDir, "apps/web");
  const wsUiRoot = path.join(tmpDir, "packages/ws-ui");

  fs.cpSync(FIXTURE_DIR, appRoot, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(FIXTURE_DIR, src).split(path.sep);
      return !rel.includes("node_modules") && rel[0] !== "dist";
    },
  });
  writeFile(
    appRoot,
    "package.json",
    JSON.stringify({
      name: "web",
      private: true,
      type: "module",
      dependencies: {
        "dep-x": "1.0.0",
        react: "19.2.7",
        "react-dom": "19.2.7",
        shiki: "*",
        vinext: "*",
        "ws-ui": "workspace:*",
      },
    }),
  );
  writeFile(
    appRoot,
    "next.config.mjs",
    `export default ${JSON.stringify({ output: "standalone", ...nextConfig })};\n`,
  );
  // No prerender: the server must render the workspace page at request time.
  writeFile(
    appRoot,
    "vite.config.ts",
    `import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({ plugins: [vinext()] });
`,
  );
  writeFile(
    appRoot,
    "pages/workspace.tsx",
    `import { Badge } from "ws-ui";

export default function Workspace() {
  return <main><Badge /></main>;
}
`,
  );

  const appNodeModules = path.join(appRoot, "node_modules");
  fs.mkdirSync(appNodeModules, { recursive: true });
  for (const entry of fs.readdirSync(FIXTURE_NODE_MODULES)) {
    if (entry.startsWith(".")) continue;
    fs.symlinkSync(
      fs.realpathSync(path.join(FIXTURE_NODE_MODULES, entry)),
      path.join(appNodeModules, entry),
      "junction",
    );
  }
  writeDepX(path.join(appNodeModules, "dep-x"), "1.0.0", "one");
  fs.symlinkSync(wsUiRoot, path.join(appNodeModules, "ws-ui"), "junction");

  writeFile(
    wsUiRoot,
    "package.json",
    JSON.stringify({
      name: "ws-ui",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      dependencies: { "dep-x": "2.0.0", react: NESTED_REACT_VERSION },
    }),
  );
  writeFile(
    wsUiRoot,
    "index.js",
    `import { createElement } from "react";
import { two } from "dep-x";

export function Badge() {
  return createElement("p", { id: "ws-ui-badge" }, "ws-ui uses " + two);
}
`,
  );
  writeDepX(path.join(wsUiRoot, "node_modules/dep-x"), "2.0.0", "two");
  writeFile(
    wsUiRoot,
    "node_modules/react/package.json",
    JSON.stringify({ name: "react", version: NESTED_REACT_VERSION, main: "index.js" }),
  );
  writeFile(
    wsUiRoot,
    "node_modules/react/index.js",
    `throw new Error("ws-ui's pinned react@${NESTED_REACT_VERSION} was loaded");\n`,
  );

  return { tmpDir, appRoot };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a port"));
      });
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone server exited early:\n${output()}`);
    }
    try {
      // Bound each probe so a server that accepts but never responds cannot
      // stall the loop past its deadline.
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Standalone server did not start:\n${output()}`);
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exited;
  }
}

type StandaloneApp = {
  standaloneDir: string;
  baseUrl: string;
  rootReactVersion: string;
  output: () => string;
};

function useStandaloneApp(nextConfig: Record<string, unknown>): StandaloneApp {
  const app = {} as StandaloneApp;
  const tmpDirs: string[] = [];
  let server: ChildProcess | undefined;

  beforeAll(async () => {
    const { tmpDir, appRoot } = createMonorepo(nextConfig);
    tmpDirs.push(tmpDir);
    app.rootReactVersion = readVersion(path.join(appRoot, "node_modules/react/package.json"));

    // execFileSync blocks the event loop, so the hook timeout cannot interrupt
    // a hung build. Bound the subprocess itself.
    execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: appRoot,
      stdio: "pipe",
      timeout: 150_000,
    });

    // Run from outside the monorepo so a missing or wrong package cannot be
    // satisfied by apps/web/node_modules or the repo's node_modules.
    app.standaloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-standalone-run-"));
    tmpDirs.push(app.standaloneDir);
    fs.cpSync(path.join(appRoot, "dist/standalone"), app.standaloneDir, { recursive: true });

    const port = await getFreePort();
    app.baseUrl = `http://127.0.0.1:${port}`;
    let output = "";
    app.output = () => output;
    server = spawn(process.execPath, [path.join(app.standaloneDir, "server.js")], {
      cwd: app.standaloneDir,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => (output += String(chunk)));
    server.stderr?.on("data", (chunk) => (output += String(chunk)));
    await waitForHttp(`${app.baseUrl}/`, server, app.output);
  }, 180_000);

  afterAll(async () => {
    await stopChildProcess(server);
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  return app;
}

describe("standalone output in a workspace where a package pins its own react", () => {
  const app = useStandaloneApp({});

  it("bundles the workspace package into the server build", () => {
    expect(fs.existsSync(path.join(app.standaloneDir, "node_modules/ws-ui"))).toBe(false);
  });

  it("copies the app root's react to the top level", () => {
    expect(app.rootReactVersion).not.toBe(NESTED_REACT_VERSION);
    expect(readVersion(path.join(app.standaloneDir, "node_modules/react/package.json"))).toBe(
      app.rootReactVersion,
    );
    expect(readVersion(path.join(app.standaloneDir, "node_modules/react-dom/package.json"))).toBe(
      app.rootReactVersion,
    );
  });

  it("renders the page that uses the workspace package", async () => {
    const res = await fetch(`${app.baseUrl}/workspace`);
    const html = await res.text();
    expect(res.status, app.output()).toBe(200);
    expect(html).toContain('<p id="ws-ui-badge">ws-ui uses dep-x v2.0.0</p>');
  });
});

describe("standalone output with a server-external package that needs a nested dependency version", () => {
  const app = useStandaloneApp({ serverExternalPackages: ["ws-ui"] });

  it("ships the workspace package as a standalone runtime dependency", () => {
    expect(fs.existsSync(path.join(app.standaloneDir, "node_modules/ws-ui/package.json"))).toBe(
      true,
    );
  });

  it("copies the app root's react to the top level", () => {
    expect(readVersion(path.join(app.standaloneDir, "node_modules/react/package.json"))).toBe(
      app.rootReactVersion,
    );
  });

  it("renders with the dependency version the external package resolves", async () => {
    // The app root also installs dep-x@1.0.0, which has no `two` export. The
    // standalone output must give ws-ui the dep-x it resolves (2.0.0).
    const res = await fetch(`${app.baseUrl}/workspace`);
    const html = await res.text();
    expect(res.status, app.output()).toBe(200);
    expect(html).toContain('<p id="ws-ui-badge">ws-ui uses dep-x v2.0.0</p>');
  });
});
