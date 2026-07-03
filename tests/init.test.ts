import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  init,
  generateViteConfig,
  addScripts,
  getInitDeps,
  isDepInstalled,
  getReactUpgradeDeps,
  updateGitignore,
  type InitOptions,
} from "../packages/vinext/src/init.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-init-test-"));
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function mkdir(dir: string, relativePath: string): void {
  fs.mkdirSync(path.join(dir, relativePath), { recursive: true });
}

function readPkg(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
}

function readFile(dir: string, relativePath: string): string {
  return fs.readFileSync(path.join(dir, relativePath), "utf-8");
}

function snapshotProject(dir: string): string {
  const entries: string[] = [];
  const walk = (currentDir: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const relativePath = path.relative(dir, fullPath).replaceAll(path.sep, "/");
      entries.push(`--- ${relativePath} ---\n${fs.readFileSync(fullPath, "utf-8").trimEnd()}`);
    }
  };
  walk(dir);
  return entries.sort().join("\n\n");
}

function readPluginRscVendoredEdgeBundle(fileName: string): string {
  return fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs",
      fileName,
    ),
    "utf-8",
  );
}

function expectConsumedBeforeInitialization(
  source: string,
  functionName: "createMap" | "createSet" | "extractIterator",
  initializationSnippet: string,
): void {
  const start = source.indexOf(`function ${functionName}(response, model) {`);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextFunction = source.indexOf("function ", start + 1);
  const body = nextFunction === -1 ? source.slice(start) : source.slice(start, nextFunction);

  const consumedIndex = body.indexOf("model.$$consumed = !0;");
  const initializationIndex = body.indexOf(initializationSnippet);

  expect(consumedIndex).toBeGreaterThanOrEqual(0);
  expect(initializationIndex).toBeGreaterThanOrEqual(0);
  expect(consumedIndex).toBeLessThan(initializationIndex);
}

/**
 * Create a minimal Next.js-like project structure in a temp directory.
 */
function setupProject(
  dir: string,
  opts: {
    router?: "app" | "pages";
    typeModule?: boolean;
    extraPkg?: Record<string, unknown>;
  } = {},
): void {
  const router = opts.router ?? "app";
  const pkg: Record<string, unknown> = {
    name: "test-project",
    version: "1.0.0",
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", next: "^15.0.0" },
    ...opts.extraPkg,
  };
  if (opts.typeModule) {
    pkg.type = "module";
  }

  writeFile(dir, "package.json", JSON.stringify(pkg, null, 2));

  if (router === "app") {
    mkdir(dir, "app");
    writeFile(dir, "app/page.tsx", "export default function Home() { return <div>hi</div> }");
    writeFile(
      dir,
      "app/layout.tsx",
      "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
    );
  } else {
    mkdir(dir, "pages");
    writeFile(dir, "pages/index.tsx", "export default function Home() { return <div>hi</div> }");
  }
}

/** No-op exec for tests — records calls for assertions */
function noopExec(): {
  exec: (cmd: string, opts: { cwd: string; stdio: string }) => string | void;
  calls: Array<{ cmd: string; opts: { cwd: string; stdio: string } }>;
} {
  const calls: Array<{ cmd: string; opts: { cwd: string; stdio: string } }> = [];
  return {
    exec: (cmd: string, opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, opts });
    },
    calls,
  };
}

/**
 * Run init with a no-op exec and suppressed console output.
 */
async function runInit(
  dir: string,
  opts: Partial<InitOptions> = {},
): Promise<{
  result: Awaited<ReturnType<typeof init>>;
  execCalls: Array<{ cmd: string }>;
  output: string;
}> {
  const { exec, calls } = noopExec();
  const output: string[] = [];

  // Suppress console output during tests
  const consoleSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args) => output.push(args.join(" ")));
  const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  // Mock process.exit to prevent test from exiting
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  try {
    const result = await init({
      root: dir,
      skipCheck: true,
      _exec: exec,
      platform: "cloudflare",
      cloudflare: {
        dataCache: "kv",
        cdnCache: "workers-cache",
        imageOptimization: "cloudflare-images",
      },
      ...opts,
    });
    return { result, execCalls: calls, output: output.join("\n") };
  } finally {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

/**
 * Run init expecting it to fail (process.exit).
 */
async function runInitExpectExit(dir: string, opts: Partial<InitOptions> = {}): Promise<string> {
  const { exec } = noopExec();

  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  try {
    await init({
      root: dir,
      skipCheck: true,
      _exec: exec,
      platform: "cloudflare",
      cloudflare: {
        dataCache: "kv",
        cdnCache: "workers-cache",
        imageOptimization: "cloudflare-images",
      },
      ...opts,
    });
    throw new Error("Expected process.exit to be called");
  } catch (e) {
    return (e as Error).message;
  } finally {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Unit Tests: generateViteConfig ──────────────────────────────────────────

describe("generateViteConfig", () => {
  it("generates App Router config with RSC plugin", () => {
    const config = generateViteConfig(true);
    expect(config).toContain('import vinext from "vinext"');
    expect(config).toContain("vinext()");
  });

  it("generates Pages Router config without RSC", () => {
    const config = generateViteConfig(false);
    expect(config).toContain('import vinext from "vinext"');
    expect(config).toContain("vinext()");
    expect(config).not.toContain("plugin-rsc");
    expect(config).not.toContain("rsc(");
  });

  it("does not include cloudflare plugin", () => {
    expect(generateViteConfig(true)).not.toContain("cloudflare");
    expect(generateViteConfig(false)).not.toContain("cloudflare");
  });

  it("includes defineConfig import", () => {
    expect(generateViteConfig(true)).toContain("defineConfig");
    expect(generateViteConfig(false)).toContain("defineConfig");
  });

  it("can configure prerender for all routes", () => {
    const config = generateViteConfig(true, true);
    expect(config).toContain('vinext({ prerender: { routes: "*" } })');
  });
});

// ─── Unit Tests: addScripts ──────────────────────────────────────────────────

describe("addScripts", () => {
  it("adds dev:vinext, build:vinext, and start:vinext scripts", () => {
    setupProject(tmpDir, { router: "app" });

    const added = addScripts(tmpDir, 3001);

    expect(added).toContain("dev:vinext");
    expect(added).toContain("build:vinext");
    expect(added).toContain("start:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vinext dev --port 3001");
    expect(pkg.scripts["build:vinext"]).toBe("vinext build");
    expect(pkg.scripts["start:vinext"]).toBe("vinext start");
    expect(pkg.scripts["deploy:vinext"]).toBeUndefined();
  });

  it("adds deploy:vinext for Cloudflare projects", () => {
    setupProject(tmpDir, { router: "app" });

    const added = addScripts(tmpDir, 3001, "cloudflare");

    expect(added).toContain("deploy:vinext");
    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["start:vinext"]).toBe("wrangler dev --config dist/server/wrangler.json");
    expect(pkg.scripts["deploy:vinext"]).toBe("vinext-cloudflare deploy");
  });

  it("uses custom port", () => {
    setupProject(tmpDir, { router: "app" });

    addScripts(tmpDir, 4000);

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vinext dev --port 4000");
  });

  it("does not overwrite existing scripts", () => {
    setupProject(tmpDir, {
      router: "app",
      extraPkg: {
        scripts: {
          "dev:vinext": "custom-command",
          "deploy:vinext": "custom-deploy",
        },
      },
    });

    const added = addScripts(tmpDir, 3001, "cloudflare");

    expect(added).not.toContain("dev:vinext");
    expect(added).not.toContain("deploy:vinext");
    expect(added).toContain("build:vinext");
    expect(added).toContain("start:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("custom-command");
    expect(pkg.scripts["start:vinext"]).toBe("wrangler dev --config dist/server/wrangler.json");
    expect(pkg.scripts["deploy:vinext"]).toBe("custom-deploy");
  });

  it("creates scripts object if missing", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "test" }));

    const added = addScripts(tmpDir, 3001);

    expect(added).toContain("dev:vinext");
    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBeDefined();
  });

  it("returns empty array when no package.json", () => {
    const added = addScripts(tmpDir, 3001);
    expect(added).toEqual([]);
  });
});

// ─── Unit Tests: getInitDeps / isDepInstalled ────────────────────────────────

describe("getInitDeps", () => {
  it("returns vinext + vite + @vitejs/plugin-react + App Router deps for App Router", () => {
    const deps = getInitDeps(true, "cloudflare");
    expect(deps).toContain("vinext");
    expect(deps).toContain("vite");
    expect(deps).toContain("@vitejs/plugin-react");
    expect(deps).toContain("@vitejs/plugin-rsc");
    expect(deps).toContain("react-server-dom-webpack");
  });

  it("returns vinext + vite + @vitejs/plugin-react for Pages Router", () => {
    const deps = getInitDeps(false, "cloudflare");
    expect(deps).toContain("vinext");
    expect(deps).toContain("vite");
    expect(deps).toContain("@vitejs/plugin-react");
    expect(deps).not.toContain("@vitejs/plugin-rsc");
    expect(deps).not.toContain("react-server-dom-webpack");
  });

  it("adds Cloudflare deployment dependencies for the Cloudflare platform", () => {
    const deps = getInitDeps(true, "cloudflare");
    expect(deps).toContain("@cloudflare/vite-plugin");
    expect(deps).toContain("wrangler");
    expect(deps).toContain("@vinext/cloudflare");
  });

  it("does not add Cloudflare dependencies for the Node platform", () => {
    const deps = getInitDeps(true, "node");
    expect(deps).not.toContain("@cloudflare/vite-plugin");
    expect(deps).not.toContain("wrangler");
  });
});

/** Helper: create a fake resolvable react package in node_modules */
function setupFakeReact(dir: string, version: string): void {
  const reactDir = path.join(dir, "node_modules", "react");
  fs.mkdirSync(reactDir, { recursive: true });
  fs.writeFileSync(
    path.join(reactDir, "package.json"),
    JSON.stringify({ name: "react", version, main: "index.js" }),
  );
  fs.writeFileSync(path.join(reactDir, "index.js"), "");
}

describe("getReactUpgradeDeps", () => {
  it("returns react@latest + react-dom@latest when React is below the RSDW security floor", () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.5");

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual(["react@latest", "react-dom@latest"]);
  });

  it("returns empty array when React is new enough", () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.6");

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });

  it("returns empty array when React is a newer minor version", () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.3.0");

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });

  it("returns upgrade deps when React major is below 19", () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "18.3.1");

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual(["react@latest", "react-dom@latest"]);
  });

  it("returns empty array when node_modules/react does not exist", () => {
    setupProject(tmpDir, { router: "app" });
    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });
});

describe("@vitejs/plugin-rsc vendored React Flight protections", () => {
  // Regression for CVE-2026-23869. plugin-rsc vendors its own Flight decoder,
  // so the fix must be present in the vendored edge bundle that vinext uses.
  // React fix: https://github.com/facebook/react/pull/36236
  for (const fileName of [
    "react-server-dom-webpack-server.edge.development.js",
    "react-server-dom-webpack-server.edge.production.js",
  ]) {
    it(`${fileName} marks outlined containers consumed before materializing them`, () => {
      const source = readPluginRscVendoredEdgeBundle(fileName);

      expectConsumedBeforeInitialization(source, "createMap", "new Map(model)");
      expectConsumedBeforeInitialization(source, "createSet", "new Set(model)");
      expectConsumedBeforeInitialization(source, "extractIterator", "model[Symbol.iterator]()");
    });
  }
});

describe("isDepInstalled", () => {
  it("returns true when dep is in dependencies", () => {
    setupProject(tmpDir, { router: "app" });
    expect(isDepInstalled(tmpDir, "react")).toBe(true);
  });

  it("returns true when dep is in devDependencies", () => {
    setupProject(tmpDir, {
      router: "app",
      extraPkg: { devDependencies: { vite: "^7.0.0" } },
    });
    expect(isDepInstalled(tmpDir, "vite")).toBe(true);
  });

  it("returns false when dep is not installed", () => {
    setupProject(tmpDir, { router: "app" });
    expect(isDepInstalled(tmpDir, "vite")).toBe(false);
  });

  it("returns false when no package.json", () => {
    expect(isDepInstalled(tmpDir, "vite")).toBe(false);
  });
});

// ─── Integration: init() ─────────────────────────────────────────────────────

describe("init — basic functionality", () => {
  it("generates vite.config.ts for App Router project", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.generatedViteConfig).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "vite.config.ts"))).toBe(true);

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain('import vinext from "vinext"');
  });

  it("generates vite.config.ts for Pages Router project", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir);

    expect(result.generatedViteConfig).toBe(true);
    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain("vinext({");
    expect(config).toContain("data: kvDataAdapter()");
    expect(config).toContain("cdn: cdnAdapter()");
    expect(config).not.toContain("plugin-rsc");
  });

  it("generates Cloudflare deployment scaffolding by default", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.platform).toBe("cloudflare");
    expect(result.generatedPlatformFiles).toEqual(["wrangler.jsonc"]);
    expect(readFile(tmpDir, "vite.config.ts")).toContain("@cloudflare/vite-plugin");
    expect(readFile(tmpDir, "vite.config.ts")).toContain("data: kvDataAdapter()");
    expect(readFile(tmpDir, "vite.config.ts")).toContain("cdn: cdnAdapter()");
    expect(fs.existsSync(path.join(tmpDir, "worker", "index.ts"))).toBe(false);
    expect(JSON.parse(readFile(tmpDir, "wrangler.jsonc"))).toMatchObject({
      cache: { enabled: true },
      main: "vinext/server/fetch-handler",
    });
  });

  it("uses the built-in fetch handler for Pages Router Cloudflare init", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir, { platform: "cloudflare" });

    expect(result.generatedPlatformFiles).toEqual(["wrangler.jsonc"]);
    expect(fs.existsSync(path.join(tmpDir, "worker", "index.ts"))).toBe(false);
    expect(JSON.parse(readFile(tmpDir, "wrangler.jsonc"))).toMatchObject({
      main: "vinext/server/fetch-handler",
    });
  });

  it("does not configure prerender unless opted in", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir);

    expect(readFile(tmpDir, "vite.config.ts")).not.toContain("prerender:");
  });

  it("generates Node vite.config.ts with prerender when opted in", async () => {
    setupProject(tmpDir, { router: "pages" });

    await runInit(tmpDir, { platform: "node", prerender: true });

    expect(readFile(tmpDir, "vite.config.ts")).toContain('vinext({ prerender: { routes: "*" } })');
  });

  it("generates Cloudflare vite.config.ts with prerender when opted in", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, { prerender: true });

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain('prerender: { routes: "*" }');
    expect(config).toContain("data: kvDataAdapter()");
    expect(config).toContain("cdn: cdnAdapter()");
    expect(config).toContain("images: { optimizer: imagesOptimizer() }");
  });

  it("prints explicit steps to finish Cloudflare KV setup", async () => {
    setupProject(tmpDir, { router: "app" });

    const { output } = await runInit(tmpDir);

    expect(output).toContain("Cloudflare setup is incomplete until you finish KV configuration:");
    expect(output).toContain("1. Create the KV namespace:");
    expect(output).toContain("npx wrangler kv namespace create VINEXT_KV_CACHE");
    expect(output).toContain(
      "2. Copy the returned namespace ID into the VINEXT_KV_CACHE entry in wrangler.jsonc:",
    );
    expect(output).toContain('Set its "id" value, replacing "<your-kv-namespace-id>" if present.');
  });

  it("omits KV setup steps when Wrangler already has a namespace ID", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "wrangler.jsonc",
      `{
  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "existing-id" }]
}\n`,
    );

    const { output } = await runInit(tmpDir);

    expect(output).not.toContain(
      "Cloudflare setup is incomplete until you finish KV configuration:",
    );
    expect(output).not.toContain("npx wrangler kv namespace create VINEXT_KV_CACHE");
    expect(output).not.toContain("<your-kv-namespace-id>");
  });

  it("names wrangler.json when that is the configured Wrangler file", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "wrangler.json", `{ "name": "existing" }\n`);

    const { output } = await runInit(tmpDir);

    expect(output).toContain(
      "2. Copy the returned namespace ID into the VINEXT_KV_CACHE entry in wrangler.json:",
    );
    expect(output).not.toContain("entry in wrangler.jsonc:");
  });

  it("prints KV setup steps when the binding exists without an ID", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "wrangler.jsonc",
      `{
  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE" }]
}\n`,
    );

    const { output } = await runInit(tmpDir);

    expect(output).toContain("Cloudflare setup is incomplete until you finish KV configuration:");
    expect(output).toContain(
      "2. Copy the returned namespace ID into the VINEXT_KV_CACHE entry in wrangler.jsonc:",
    );
    expect(output).toContain('Set its "id" value');
  });

  it("omits KV setup steps when the data cache is disabled", async () => {
    setupProject(tmpDir, { router: "app" });

    const { output } = await runInit(tmpDir, {
      cloudflare: {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "cloudflare-images",
      },
    });

    expect(output).not.toContain(
      "Cloudflare setup is incomplete until you finish KV configuration:",
    );
    expect(output).not.toContain("npx wrangler kv namespace create VINEXT_KV_CACHE");
  });

  it("keeps Node init free of Cloudflare scaffolding", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir, { platform: "node" });

    expect(result.platform).toBe("node");
    expect(result.generatedPlatformFiles).toEqual([]);
    expect(readFile(tmpDir, "vite.config.ts")).not.toContain("@cloudflare/vite-plugin");
    expect(fs.existsSync(path.join(tmpDir, "wrangler.jsonc"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "worker", "index.ts"))).toBe(false);
  });

  it("generates Wrangler config alongside cloudflare.config.ts", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "cloudflare.config.ts", "export default {};\n");

    const { result } = await runInit(tmpDir);

    expect(result.generatedPlatformFiles).toContain("wrangler.jsonc");
    expect(JSON.parse(readFile(tmpDir, "wrangler.jsonc"))).toMatchObject({
      main: "vinext/server/fetch-handler",
    });
    expect(readFile(tmpDir, "cloudflare.config.ts")).toBe("export default {};\n");
  });

  it("supports CDN fallthrough with no data cache or image optimization", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, {
      platform: "cloudflare",
      cloudflare: { dataCache: "none", cdnCache: "data-cache", imageOptimization: "none" },
    });

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).not.toContain("data:");
    expect(config).not.toContain("cdn:");
    expect(config).not.toContain("imagesOptimizer");
    const wrangler = JSON.parse(readFile(tmpDir, "wrangler.jsonc"));
    expect(wrangler.kv_namespaces).toBeUndefined();
    expect(wrangler.images).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "worker", "index.ts"))).toBe(false);
  });

  it("additively fills missing Cloudflare config on rerun", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "vite.config.ts",
      `import vinext from "vinext";
import { customData } from "./custom-cache.js";
export default { plugins: [vinext({ cache: { data: customData() } })] };
`,
    );
    writeFile(
      tmpDir,
      "wrangler.jsonc",
      `{
  // preserve me
  "name": "custom-name",
  "kv_namespaces": [{ "binding": "OTHER", "id": "other" }]
}
`,
    );
    writeFile(tmpDir, "worker/index.ts", "export default { fetch() {} };\n");

    await runInit(tmpDir, {
      platform: "cloudflare",
      cloudflare: {
        dataCache: "kv",
        cdnCache: "workers-cache",
        imageOptimization: "cloudflare-images",
      },
    });

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain("data: customData()");
    expect(config).toContain("cdn: cdnAdapter()");
    expect(config).not.toContain("kvDataAdapter");
    const wrangler = readFile(tmpDir, "wrangler.jsonc");
    expect(wrangler).toContain("// preserve me");
    expect(wrangler).toContain('"name": "custom-name"');
    expect(wrangler).toContain('"binding": "OTHER"');
    expect(wrangler).toContain('"binding": "VINEXT_KV_CACHE"');
    expect(wrangler).toContain('"images": { "binding": "IMAGES" }');
    expect(readFile(tmpDir, "worker/index.ts")).toBe("export default { fetch() {} };\n");
  });

  it("additively fills missing prerender config on rerun", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "vite.config.ts",
      `import vinext from "vinext";

export default { plugins: [vinext({ cache: { data: customData() } })] };
`,
    );

    await runInit(tmpDir, {
      platform: "cloudflare",
      prerender: true,
      cloudflare: {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "none",
      },
    });

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain("cache: { data: customData() }");
    expect(config).toContain('prerender: { routes: "*" }');
  });

  it("rejects Wrangler TOML", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "wrangler.toml",
      'name = "existing"\nimages = { binding = "CUSTOM_IMAGES" }\n',
    );
    const before = snapshotProject(tmpDir);

    await expect(runInit(tmpDir)).rejects.toThrow("wrangler.toml is not supported");
    expect(snapshotProject(tmpDir)).toBe(before);
  });

  it("rejects malformed Wrangler JSONC before mutating the project", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "wrangler.jsonc", `{ "name": "broken",\n`);
    const before = snapshotProject(tmpDir);
    const exec = vi.fn();

    await expect(runInit(tmpDir, { _exec: exec })).rejects.toThrow(
      "Could not parse the existing Wrangler JSON/JSONC config",
    );
    expect(exec).not.toHaveBeenCalled();
    expect(snapshotProject(tmpDir)).toBe(before);
  });

  it("rejects unsupported Vite config structures before mutating the project", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", `const config = getConfig(); export default config;\n`);
    const before = snapshotProject(tmpDir);
    const exec = vi.fn();

    await expect(runInit(tmpDir, { _exec: exec })).rejects.toThrow(
      "Could not find a static Vite config object",
    );
    expect(exec).not.toHaveBeenCalled();
    expect(snapshotProject(tmpDir)).toBe(before);
  });

  it("points wrangler.jsonc at an existing JavaScript worker entry", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "worker/index.js", "export default {};");

    await runInit(tmpDir);

    expect(JSON.parse(readFile(tmpDir, "wrangler.jsonc"))).toMatchObject({
      main: "./worker/index.js",
    });
    expect(fs.existsSync(path.join(tmpDir, "worker", "index.ts"))).toBe(false);
  });

  it("adds 'type': 'module' to package.json", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.addedTypeModule).toBe(true);
    const pkg = readPkg(tmpDir);
    expect(pkg.type).toBe("module");
  });

  it("skips adding 'type': 'module' when already present", async () => {
    setupProject(tmpDir, { router: "app", typeModule: true });

    const { result } = await runInit(tmpDir);

    expect(result.addedTypeModule).toBe(false);
  });

  it("adds dev:vinext, build:vinext, start:vinext, and deploy:vinext scripts", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.addedScripts).toContain("dev:vinext");
    expect(result.addedScripts).toContain("build:vinext");
    expect(result.addedScripts).toContain("start:vinext");
    expect(result.addedScripts).toContain("deploy:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vinext dev --port 3001");
    expect(pkg.scripts["build:vinext"]).toBe("vinext build");
    expect(pkg.scripts["start:vinext"]).toBe("wrangler dev --config dist/server/wrangler.json");
    expect(pkg.scripts["deploy:vinext"]).toBe("vinext-cloudflare deploy");
  });

  it("does not add deploy:vinext for Node init", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir, { platform: "node" });

    expect(result.addedScripts).not.toContain("deploy:vinext");
    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["start:vinext"]).toBe("vinext start");
    expect(pkg.scripts["deploy:vinext"]).toBeUndefined();
  });

  it("uses custom port in dev:vinext script", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, { port: 4000 });

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vinext dev --port 4000");
  });

  it("does not overwrite existing scripts", async () => {
    setupProject(tmpDir, {
      router: "app",
      extraPkg: { scripts: { "dev:vinext": "custom-command" } },
    });

    const { result } = await runInit(tmpDir);

    expect(result.addedScripts).not.toContain("dev:vinext");
    expect(result.addedScripts).toContain("build:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("custom-command");
  });
});

describe("init — generated project snapshots", () => {
  it("snapshots a fresh Cloudflare App Router init", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, { platform: "cloudflare", _today: "2026-06-23" });

    expect(snapshotProject(tmpDir)).toMatchSnapshot();
  });

  it("snapshots a fresh Node Pages Router init", async () => {
    setupProject(tmpDir, { router: "pages" });

    await runInit(tmpDir, { platform: "node" });

    expect(snapshotProject(tmpDir)).toMatchSnapshot();
  });

  it("snapshots an AST update to an existing Vite config", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "vite.config.ts",
      `import { defineConfig } from "vite";
import vinext from "vinext";
import custom from "./custom.js";

export default defineConfig({
  plugins: [custom(), vinext()],
  server: { port: 4321 },
});
`,
    );

    await runInit(tmpDir, { platform: "cloudflare", _today: "2026-06-23" });

    expect(snapshotProject(tmpDir)).toMatchSnapshot();
  });
});

// ─── CJS Config Renaming ────────────────────────────────────────────────────

describe("init — CJS config renaming", () => {
  it("renames CJS postcss.config.js to .cjs", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "postcss.config.js", "module.exports = { plugins: {} };");

    const { result } = await runInit(tmpDir);

    expect(result.renamedConfigs).toContainEqual(["postcss.config.js", "postcss.config.cjs"]);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(false);
  });

  it("does not rename ESM config files", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "postcss.config.js", "export default { plugins: {} };");

    const { result } = await runInit(tmpDir);

    expect(result.renamedConfigs).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, "postcss.config.js"))).toBe(true);
  });
});

// ─── Dependency Installation ─────────────────────────────────────────────────

describe("init — dependency installation", () => {
  it("prints dependencies as a dashed list", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { output } = await runInit(tmpDir);

    expect(output).toContain("  Installing dependencies:\n    - vinext\n    - @vinext/cloudflare");
    expect(output).toContain(
      "  Installing devDependencies:\n    - vite\n    - @vitejs/plugin-react",
    );
    expect(output).toContain("    ✓ Added dependencies to dependencies:\n      - vinext");
    expect(output).toContain(
      "    ✓ Added dependencies to devDependencies:\n      - vite\n      - @vitejs/plugin-react",
    );
    expect(output).not.toContain("Installing vinext, vite");
  });

  it("writes all project setup before invoking the package manager", async () => {
    setupProject(tmpDir, { router: "app" });
    const setupAtInstall: Array<{
      scripts: Record<string, string>;
      viteConfigExists: boolean;
      wranglerConfigExists: boolean;
      gitignore: string;
    }> = [];

    await runInit(tmpDir, {
      _exec: () => {
        const packageJson = JSON.parse(readFile(tmpDir, "package.json"));
        setupAtInstall.push({
          scripts: packageJson.scripts,
          viteConfigExists: fs.existsSync(path.join(tmpDir, "vite.config.ts")),
          wranglerConfigExists: fs.existsSync(path.join(tmpDir, "wrangler.jsonc")),
          gitignore: readFile(tmpDir, ".gitignore"),
        });
      },
    });

    expect(setupAtInstall.length).toBeGreaterThan(0);
    for (const setup of setupAtInstall) {
      expect(setup.scripts).toMatchObject({
        "dev:vinext": "vinext dev --port 3001",
        "build:vinext": "vinext build",
        "start:vinext": "wrangler dev --config dist/server/wrangler.json",
        "deploy:vinext": "vinext-cloudflare deploy",
      });
      expect(setup.viteConfigExists).toBe(true);
      expect(setup.wranglerConfigExists).toBe(true);
      expect(setup.gitignore).toContain(".vinext/");
      expect(setup.gitignore).toContain("dist/");
    }
  });

  it("leaves the project fully configured when dependency installation fails", async () => {
    setupProject(tmpDir, { router: "app" });

    await expect(
      runInit(tmpDir, {
        _exec: () => {
          throw new Error("dependency install requires script approval");
        },
      }),
    ).rejects.toThrow("dependency install requires script approval");

    const packageJson = JSON.parse(readFile(tmpDir, "package.json"));
    expect(packageJson).toMatchObject({
      type: "module",
      scripts: {
        "dev:vinext": "vinext dev --port 3001",
        "build:vinext": "vinext build",
        "start:vinext": "wrangler dev --config dist/server/wrangler.json",
        "deploy:vinext": "vinext-cloudflare deploy",
      },
    });
    expect(fs.existsSync(path.join(tmpDir, "vite.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "wrangler.jsonc"))).toBe(true);
    expect(readFile(tmpDir, ".gitignore")).toContain(".vinext/");
    expect(readFile(tmpDir, ".gitignore")).toContain("dist/");
  });

  it("adds pnpm approve-builds recovery instructions for blocked build scripts", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const { result, output } = await runInit(tmpDir, {
      _exec: () => {
        const error = new Error("pnpm install failed") as Error & { stderr: string };
        error.stderr =
          "Ignored build scripts: esbuild. Run pnpm approve-builds to pick which dependencies should be allowed to run scripts.";
        throw error;
      },
    });

    expect(result.installedDeps).toEqual([]);
    expect(output).toContain("Dependency installation is waiting for build-script approval");
    expect(output).toContain(
      "Dependency installation is incomplete because pnpm blocked dependency build scripts:",
    );
    expect(output).toContain("1. Review and approve the required build scripts:");
    expect(output).toContain("pnpm approve-builds");
    expect(output).toContain("2. Finish installing dependencies:");
    expect(output).toContain("pnpm install");
    expect(output).not.toContain("Added dependencies to devDependencies:");
  });

  it("detects blocked builds after a successful pnpm install", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const { result, output } = await runInit(tmpDir, {
      _inspectPnpmIgnoredBuilds: () =>
        "Automatically ignored builds during installation:\n  esbuild\n  workerd\n",
    });

    expect(result.installedDeps).toContain("vinext");
    expect(output).toContain("pnpm approve-builds");
    expect(output).toContain("pnpm install");
    expect(output).toContain("Added dependencies to devDependencies:");
  });

  it("does not request approval when pnpm has no automatically ignored builds", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const { result, output } = await runInit(tmpDir, {
      _inspectPnpmIgnoredBuilds: () =>
        "Automatically ignored builds during installation:\n  None\n\nExplicitly ignored package builds:\n  msw\n",
    });

    expect(result.installedDeps).toContain("vinext");
    expect(output).not.toContain("pnpm approve-builds");
  });

  it("does not classify non-pnpm install failures as approve-builds errors", async () => {
    setupProject(tmpDir, { router: "pages" });

    await expect(
      runInit(tmpDir, {
        _exec: () => {
          throw new Error("Ignored build scripts: unrelated npm failure");
        },
      }),
    ).rejects.toThrow("Ignored build scripts: unrelated npm failure");
  });

  it("continues the main dependency add after a React approve-builds warning", async () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.3");
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const commands: string[] = [];

    const { result, output } = await runInit(tmpDir, {
      _exec: (cmd) => {
        commands.push(cmd);
        if (cmd.includes("react@latest")) {
          throw Object.assign(new Error("pnpm add failed"), {
            output: "Ignored build scripts. Run pnpm approve-builds.",
          });
        }
      },
    });

    expect(
      commands.some((cmd) => cmd.includes("react-server-dom-webpack") && !cmd.includes("-D")),
    ).toBe(true);
    expect(result.installedDeps).toContain("react-server-dom-webpack");
    expect(output).toContain("pnpm approve-builds");
  });

  it("detects missing vinext and vite dependencies and installs them", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("vinext");
    expect(result.installedDeps).toContain("vite");
  });

  it("detects missing @vitejs/plugin-rsc for App Router", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-react");
    expect(result.installedDeps).toContain("@vitejs/plugin-rsc");
  });

  it("treats src/app projects as App Router", async () => {
    setupProject(tmpDir);
    fs.rmSync(path.join(tmpDir, "app"), { recursive: true, force: true });

    mkdir(tmpDir, "src/app");
    writeFile(
      tmpDir,
      "src/app/page.tsx",
      "export default function Home() { return <div>hi</div> }",
    );
    writeFile(
      tmpDir,
      "src/app/layout.tsx",
      "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
    );

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-react");
    expect(result.installedDeps).toContain("@vitejs/plugin-rsc");
    expect(result.installedDeps).toContain("react-server-dom-webpack");
  });

  it("detects missing react-server-dom-webpack for App Router", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-react");
    expect(result.installedDeps).toContain("react-server-dom-webpack");
  });

  it("does not require @vitejs/plugin-rsc for Pages Router", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-react");
    expect(result.installedDeps).not.toContain("@vitejs/plugin-rsc");
  });

  it("does not require react-server-dom-webpack for Pages Router", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-react");
    expect(result.installedDeps).not.toContain("react-server-dom-webpack");
  });

  it("upgrades React before installing dev deps when React is too old (App Router)", async () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.3");

    const { execCalls } = await runInit(tmpDir);

    // The first exec call should be the React upgrade (without -D)
    const reactUpgradeCall = execCalls.find(
      (c) => c.cmd.includes("react@latest") && c.cmd.includes("react-dom@latest"),
    );
    expect(reactUpgradeCall).toBeDefined();
    // The React upgrade should NOT use -D flag (keeps them in dependencies)
    expect(reactUpgradeCall!.cmd).not.toContain("-D");

    // The second exec call should install runtime framework deps (without -D).
    const runtimeDepsCall = execCalls.find(
      (c) => c.cmd.includes("react-server-dom-webpack") && !c.cmd.includes("-D"),
    );
    expect(runtimeDepsCall).toBeDefined();

    // The dev deps install should still use -D.
    const devDepsCall = execCalls.find(
      (c) =>
        c.cmd.includes("@vitejs/plugin-react") &&
        c.cmd.includes("@vitejs/plugin-rsc") &&
        c.cmd.includes("-D"),
    );
    expect(devDepsCall).toBeDefined();

    // React upgrade should come before framework deps that peer on React.
    const upgradeIdx = execCalls.indexOf(reactUpgradeCall!);
    const runtimeDepsIdx = execCalls.indexOf(runtimeDepsCall!);
    const devDepsIdx = execCalls.indexOf(devDepsCall!);
    expect(upgradeIdx).toBeLessThan(runtimeDepsIdx);
    expect(runtimeDepsIdx).toBeLessThan(devDepsIdx);
  });

  it("does not upgrade React when version is already compatible", async () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.6");

    const { execCalls } = await runInit(tmpDir);

    // No React upgrade call
    const reactUpgradeCall = execCalls.find((c) => c.cmd.includes("react@latest"));
    expect(reactUpgradeCall).toBeUndefined();
  });

  function withUserAgent<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const previous = process.env.npm_config_user_agent;
    if (value === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = value;
    }

    return run().finally(() => {
      if (previous === undefined) {
        delete process.env.npm_config_user_agent;
      } else {
        process.env.npm_config_user_agent = previous;
      }
    });
  }

  it("calls exec with correct package manager for pnpm", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: 5");

    const { execCalls } = await runInit(tmpDir);

    const installCall = execCalls.find(
      (c) => c.cmd.includes("add -D") || c.cmd.includes("install -D"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^pnpm add -D/);
  });

  it("can write missing dependency entries without installing them", async () => {
    setupProject(tmpDir, { router: "app" });

    const { execCalls } = await runInit(tmpDir, { install: false });
    const pkg = readPkg(tmpDir) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(execCalls).toEqual([]);
    expect(pkg.dependencies).toMatchObject({
      vinext: "latest",
      "react-server-dom-webpack": "latest",
      "@vinext/cloudflare": "latest",
    });
    expect(pkg.devDependencies).toMatchObject({
      vite: "latest",
      "@vitejs/plugin-react": "latest",
      "@vitejs/plugin-rsc": "latest",
      "@cloudflare/vite-plugin": "latest",
      wrangler: "latest",
    });
  });

  it("updates old React dependency entries without installing when install is disabled", async () => {
    setupProject(tmpDir, { router: "app" });
    setupFakeReact(tmpDir, "19.2.3");

    const { execCalls, output } = await runInit(tmpDir, { install: false });
    const pkg = readPkg(tmpDir) as {
      dependencies?: Record<string, string>;
    };

    expect(execCalls).toEqual([]);
    expect(pkg.dependencies).toMatchObject({
      react: "latest",
      "react-dom": "latest",
    });
    expect(output).toContain(
      "Added dependencies to dependencies:\n      - react\n      - react-dom",
    );
  });

  it("calls exec with bun when bun.lock exists", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "bun.lock", "# bun lockfile");

    const { execCalls } = await runInit(tmpDir);

    const installCall = execCalls.find(
      (c) => c.cmd.includes("add -D") || c.cmd.includes("install -D"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^bun add -D/);
  });

  it("uses package.json#packageManager when lock files are missing", async () => {
    setupProject(tmpDir, {
      router: "pages",
      extraPkg: { packageManager: "bun@1.2.3" },
    });

    const { execCalls } = await runInit(tmpDir);

    const installCall = execCalls.find(
      (c) => c.cmd.includes("add -D") || c.cmd.includes("install -D"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^bun add -D/);
  });

  it("uses invoking package manager from npm_config_user_agent when project has no PM hints", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { execCalls } = await withUserAgent("bun/1.2.3 npm/? node/v22.0.0", () =>
      runInit(tmpDir),
    );

    const installCall = execCalls.find(
      (c) => c.cmd.includes("add -D") || c.cmd.includes("install -D"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^bun add -D/);
  });

  it("falls back to npm when no lock file, no packageManager, and no user-agent hint", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { execCalls } = await withUserAgent(undefined, () => runInit(tmpDir));

    const installCall = execCalls.find(
      (c) => c.cmd.includes("install -D") || c.cmd.includes("add -D"),
    );
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^npm install -D/);
  });
});

// ─── Guard Rails ─────────────────────────────────────────────────────────────

describe("init — guard rails", () => {
  it("skips vite.config.ts when it already exists (without --force)", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir, { platform: "node" });

    expect(result.generatedViteConfig).toBe(false);
    expect(result.skippedViteConfig).toBe(true);
    // Original config should be preserved
    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toBe("export default {}");
  });

  it("still runs all other steps when vite.config.ts exists", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir, { platform: "node" });

    // Dependencies should still be installed
    expect(result.installedDeps).toContain("vite");
    // ESM migration should still happen
    expect(result.addedTypeModule).toBe(true);
    // Scripts should still be added
    expect(result.addedScripts).toContain("dev:vinext");
    expect(result.addedScripts).toContain("build:vinext");
    expect(result.addedScripts).toContain("start:vinext");
    expect(result.addedScripts).not.toContain("deploy:vinext");
    // But vite config should be skipped
    expect(result.generatedViteConfig).toBe(false);
    expect(result.skippedViteConfig).toBe(true);
  });

  it("AST-updates a Cloudflare init when the existing Vite config lacks plugins", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    await runInit(tmpDir);

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain('import vinext from "vinext"');
    expect(config).toContain("vinext({");
    expect(config).toContain("cloudflare(");
  });

  it("uses an existing Cloudflare plugin import when adding the call", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(
      tmpDir,
      "vite.config.ts",
      'import { cloudflare } from "@cloudflare/vite-plugin";\nexport default {};',
    );

    await runInit(tmpDir);

    const config = readFile(tmpDir, "vite.config.ts");
    expect(config.match(/@cloudflare\/vite-plugin/g)).toHaveLength(1);
    expect(config).toContain("cloudflare(");
  });

  it("AST-updates vite.config.ts with --force", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir, { force: true });

    expect(result.generatedViteConfig).toBe(true);
    expect(result.skippedViteConfig).toBe(false);
    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain("vinext({");
  });

  for (const extension of ["js", "mjs"] as const) {
    it(`overwrites vite.config.${extension} in place with --force`, async () => {
      setupProject(tmpDir, { router: "app" });
      writeFile(tmpDir, `vite.config.${extension}`, "export default {}");

      await runInit(tmpDir, { force: true });

      expect(readFile(tmpDir, `vite.config.${extension}`)).toContain("cloudflare(");
      expect(fs.existsSync(path.join(tmpDir, "vite.config.ts"))).toBe(false);
    });
  }

  it("overwrites the active Vite config when multiple config files exist", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default { ignored: true }");
    writeFile(tmpDir, "vite.config.js", "export default { active: true }");

    await runInit(tmpDir, { force: true });

    expect(readFile(tmpDir, "vite.config.js")).toContain("cloudflare(");
    expect(readFile(tmpDir, "vite.config.ts")).toContain("ignored: true");
  });

  it("AST-updates a CommonJS Vite config with --force", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.cjs", "module.exports = {}");

    await runInit(tmpDir, { force: true });

    const config = readFile(tmpDir, "vite.config.cjs");
    expect(config).toContain('const vinext = require("vinext")');
    expect(config).toContain('require("@cloudflare/vite-plugin")');
    expect(config).toContain("cloudflare(");
  });

  it("renames and AST-updates a CommonJS vite.config.js before enabling ESM", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.js", "module.exports = { server: { port: 4321 } };\n");

    const { result } = await runInit(tmpDir, { force: true });

    expect(result.renamedConfigs).toContainEqual(["vite.config.js", "vite.config.cjs"]);
    expect(fs.existsSync(path.join(tmpDir, "vite.config.js"))).toBe(false);
    const config = readFile(tmpDir, "vite.config.cjs");
    expect(config).toContain('const vinext = require("vinext")');
    expect(config).toContain('const { cloudflare } = require("@cloudflare/vite-plugin")');
    expect(config).toContain("server: { port: 4321 }");
    expect(config).not.toContain("import ");
  });

  it("refuses to overwrite an existing vite.config.cjs during CommonJS migration", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.js", "module.exports = {};\n");
    writeFile(tmpDir, "vite.config.cjs", "module.exports = { existing: true };\n");
    const packageJsonBefore = readFile(tmpDir, "package.json");

    await expect(runInit(tmpDir, { force: true })).rejects.toThrow(
      "vite.config.cjs already exists",
    );

    expect(readFile(tmpDir, "vite.config.js")).toBe("module.exports = {};\n");
    expect(readFile(tmpDir, "vite.config.cjs")).toContain("existing: true");
    expect(readFile(tmpDir, "package.json")).toBe(packageJsonBefore);
  });

  it("exits when no package.json exists", async () => {
    mkdir(tmpDir, "app");

    const msg = await runInitExpectExit(tmpDir);
    expect(msg).toContain("process.exit(1)");
  });
});

// ─── Preserves Existing Project ─────────��────────────────────────────────────

describe("init — non-destructive", () => {
  it("preserves existing package.json fields", async () => {
    setupProject(tmpDir, {
      router: "app",
      extraPkg: {
        scripts: { dev: "next dev", build: "next build" },
        dependencies: { react: "^19.0.0", next: "^15.0.0" },
      },
    });

    await runInit(tmpDir);

    const pkg = readPkg(tmpDir) as Record<string, Record<string, string>>;
    expect(pkg.scripts.dev).toBe("next dev");
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.dependencies.react).toBe("^19.0.0");
    expect(pkg.dependencies.next).toBe("^15.0.0");
  });

  it("does not modify source files", async () => {
    setupProject(tmpDir, { router: "app" });
    const originalPage = readFile(tmpDir, "app/page.tsx");

    await runInit(tmpDir);

    expect(readFile(tmpDir, "app/page.tsx")).toBe(originalPage);
  });

  it("does not modify next.config", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "next.config.mjs", "export default {};");
    const originalConfig = readFile(tmpDir, "next.config.mjs");

    await runInit(tmpDir);

    expect(readFile(tmpDir, "next.config.mjs")).toBe(originalConfig);
  });
});

// ─── Unit Tests: updateGitignore ─────────────────────────────────────────────

describe("updateGitignore", () => {
  it("creates .gitignore with vinext output directories when file does not exist", () => {
    const result = updateGitignore(tmpDir);

    expect(result).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("/dist/\n.vinext/\n");
  });

  it("appends vinext output directories to existing .gitignore", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\n.env\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\n.env\n/dist/\n.vinext/\n");
  });

  it("appends only .vinext/ when /dist/ is already present", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\n/dist/\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\n/dist/\n.vinext/\n");
  });

  it("does not duplicate entries when already present", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\n/dist/\n.vinext/\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(false);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\n/dist/\n.vinext/\n");
  });

  it("handles .gitignore without trailing newline", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\n/dist/\n.vinext/\n");
  });

  it("handles existing entries with surrounding whitespace", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\n  /dist/  \n  .vinext/  \n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(false);
  });

  it("does not add /dist/ when dist/ (without leading slash) is already present", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\ndist/\n.vinext/\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(false);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\ndist/\n.vinext/\n");
  });

  it("does not add /dist/ when bare dist is already present", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\ndist\n.vinext/\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(false);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\ndist\n.vinext/\n");
  });

  it("does not add .vinext/ when anchored variant is already present", () => {
    writeFile(tmpDir, ".gitignore", "node_modules/\n/dist/\n/.vinext/\n");

    const result = updateGitignore(tmpDir);

    expect(result).toBe(false);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toBe("node_modules/\n/dist/\n/.vinext/\n");
  });

  it("adds .wrangler/ for the Cloudflare platform", () => {
    const result = updateGitignore(tmpDir, "cloudflare");

    expect(result).toBe(true);
    expect(readFile(tmpDir, ".gitignore")).toBe("/dist/\n.vinext/\n.wrangler/\n");
  });

  it("does not duplicate an existing Wrangler directory entry", () => {
    writeFile(tmpDir, ".gitignore", "/dist/\n.vinext/\n/.wrangler/\n");

    const result = updateGitignore(tmpDir, "cloudflare");

    expect(result).toBe(false);
    expect(readFile(tmpDir, ".gitignore")).toBe("/dist/\n.vinext/\n/.wrangler/\n");
  });
});

// ─── Integration: init updates .gitignore ────────────────────────────────────

describe("init — .gitignore", () => {
  it("adds vinext output directories to .gitignore during init", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.updatedGitignore).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toContain("/dist/");
    expect(content).toContain(".vinext/");
    expect(content).toContain(".wrangler/");
  });

  it("does not add .wrangler/ for the Node platform", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, { platform: "node" });

    expect(readFile(tmpDir, ".gitignore")).not.toContain(".wrangler/");
  });

  it("does not duplicate entries if already in .gitignore", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, ".gitignore", "node_modules/\n/dist/\n.vinext/\n.wrangler/\n");

    const { result } = await runInit(tmpDir);

    expect(result.updatedGitignore).toBe(false);
    // Ensure no duplication
    const content = readFile(tmpDir, ".gitignore");
    const matches = content.split("\n").filter((l: string) => l.trim() === "/dist/");
    expect(matches.length).toBe(1);
    const vinextMatches = content.split("\n").filter((l: string) => l.trim() === ".vinext/");
    expect(vinextMatches.length).toBe(1);
    const wranglerMatches = content.split("\n").filter((l: string) => l.trim() === ".wrangler/");
    expect(wranglerMatches.length).toBe(1);
  });

  it("preserves existing .gitignore entries when adding vinext output directories", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, ".gitignore", "node_modules/\n.env\n.next/\n");

    const { result } = await runInit(tmpDir);

    expect(result.updatedGitignore).toBe(true);
    const content = readFile(tmpDir, ".gitignore");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".env");
    expect(content).toContain(".next/");
    expect(content).toContain("/dist/");
    expect(content).toContain(".vinext/");
  });
});
