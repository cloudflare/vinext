import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    writeFile(dir, "app/page.tsx", 'export default function Home() { return <div>hi</div> }');
    writeFile(
      dir,
      "app/layout.tsx",
      "export default function Layout({ children }) { return <html><body>{children}</body></html> }",
    );
  } else {
    mkdir(dir, "pages");
    writeFile(dir, "pages/index.tsx", 'export default function Home() { return <div>hi</div> }');
  }
}

/** No-op exec for tests — records calls for assertions */
function noopExec(): {
  exec: (cmd: string, opts: { cwd: string; stdio: string }) => void;
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
): Promise<{ result: Awaited<ReturnType<typeof init>>; execCalls: Array<{ cmd: string }> }> {
  const { exec, calls } = noopExec();

  // Suppress console output during tests
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
      ...opts,
    });
    return { result, execCalls: calls };
  } finally {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

/**
 * Run init expecting it to fail (process.exit).
 */
async function runInitExpectExit(
  dir: string,
  opts: Partial<InitOptions> = {},
): Promise<string> {
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
});

// ─── Unit Tests: addScripts ──────────────────────────────────────────────────

describe("addScripts", () => {
  it("adds dev:vinext and build:vinext scripts", () => {
    setupProject(tmpDir, { router: "app" });

    const added = addScripts(tmpDir, 3001);

    expect(added).toContain("dev:vinext");
    expect(added).toContain("build:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vite dev --port 3001");
    expect(pkg.scripts["build:vinext"]).toBe("vite build");
  });

  it("uses custom port", () => {
    setupProject(tmpDir, { router: "app" });

    addScripts(tmpDir, 4000);

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vite dev --port 4000");
  });

  it("does not overwrite existing scripts", () => {
    setupProject(tmpDir, {
      router: "app",
      extraPkg: { scripts: { "dev:vinext": "custom-command" } },
    });

    const added = addScripts(tmpDir, 3001);

    expect(added).not.toContain("dev:vinext");
    expect(added).toContain("build:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("custom-command");
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
  it("returns vinext + vite + @vitejs/plugin-rsc + react-server-dom-webpack for App Router", () => {
    const deps = getInitDeps(true);
    expect(deps).toContain("vinext");
    expect(deps).toContain("vite");
    expect(deps).toContain("@vitejs/plugin-rsc");
    expect(deps).toContain("react-server-dom-webpack");
  });

  it("returns vinext + vite for Pages Router", () => {
    const deps = getInitDeps(false);
    expect(deps).toContain("vinext");
    expect(deps).toContain("vite");
    expect(deps).not.toContain("@vitejs/plugin-rsc");
    expect(deps).not.toContain("react-server-dom-webpack");
  });
});

describe("getReactUpgradeDeps", () => {
  it("returns react@latest + react-dom@latest when React is too old", () => {
    setupProject(tmpDir, { router: "app" });
    // Simulate installed react@19.2.3 (too old for react-server-dom-webpack@19.2.4)
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.3" }),
    );

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual(["react@latest", "react-dom@latest"]);
  });

  it("returns empty array when React is new enough", () => {
    setupProject(tmpDir, { router: "app" });
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.4" }),
    );

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });

  it("returns empty array when React is a newer minor version", () => {
    setupProject(tmpDir, { router: "app" });
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.3.0" }),
    );

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });

  it("returns upgrade deps when React major is below 19", () => {
    setupProject(tmpDir, { router: "app" });
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "18.3.1" }),
    );

    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual(["react@latest", "react-dom@latest"]);
  });

  it("returns empty array when node_modules/react does not exist", () => {
    setupProject(tmpDir, { router: "app" });
    const deps = getReactUpgradeDeps(tmpDir);
    expect(deps).toEqual([]);
  });
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
    expect(config).toContain("vinext()");
    expect(config).not.toContain("plugin-rsc");
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

  it("adds dev:vinext and build:vinext scripts", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.addedScripts).toContain("dev:vinext");
    expect(result.addedScripts).toContain("build:vinext");

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vite dev --port 3001");
    expect(pkg.scripts["build:vinext"]).toBe("vite build");
  });

  it("uses custom port in dev:vinext script", async () => {
    setupProject(tmpDir, { router: "app" });

    await runInit(tmpDir, { port: 4000 });

    const pkg = readPkg(tmpDir) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:vinext"]).toBe("vite dev --port 4000");
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
  it("detects missing vinext and vite dependencies and installs them", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("vinext");
    expect(result.installedDeps).toContain("vite");
  });

  it("detects missing @vitejs/plugin-rsc for App Router", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("@vitejs/plugin-rsc");
  });

  it("detects missing react-server-dom-webpack for App Router", async () => {
    setupProject(tmpDir, { router: "app" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).toContain("react-server-dom-webpack");
  });

  it("does not require @vitejs/plugin-rsc for Pages Router", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).not.toContain("@vitejs/plugin-rsc");
  });

  it("does not require react-server-dom-webpack for Pages Router", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { result } = await runInit(tmpDir);

    expect(result.installedDeps).not.toContain("react-server-dom-webpack");
  });

  it("upgrades React before installing dev deps when React is too old (App Router)", async () => {
    setupProject(tmpDir, { router: "app" });
    // Simulate react@19.2.3 in node_modules (too old for rsdw)
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.3" }),
    );

    const { execCalls } = await runInit(tmpDir);

    // The first exec call should be the React upgrade (without -D)
    const reactUpgradeCall = execCalls.find(
      (c) => c.cmd.includes("react@latest") && c.cmd.includes("react-dom@latest"),
    );
    expect(reactUpgradeCall).toBeDefined();
    // The React upgrade should NOT use -D flag (keeps them in dependencies)
    expect(reactUpgradeCall!.cmd).not.toContain("-D");

    // The second exec call should be the dev deps install (with -D)
    const devDepsCall = execCalls.find(
      (c) => c.cmd.includes("react-server-dom-webpack") && c.cmd.includes("-D"),
    );
    expect(devDepsCall).toBeDefined();

    // React upgrade should come before dev deps install
    const upgradeIdx = execCalls.indexOf(reactUpgradeCall!);
    const devDepsIdx = execCalls.indexOf(devDepsCall!);
    expect(upgradeIdx).toBeLessThan(devDepsIdx);
  });

  it("does not upgrade React when version is already compatible", async () => {
    setupProject(tmpDir, { router: "app" });
    // Simulate react@19.2.4 in node_modules (compatible)
    const reactDir = path.join(tmpDir, "node_modules", "react");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({ name: "react", version: "19.2.4" }),
    );

    const { execCalls } = await runInit(tmpDir);

    // No React upgrade call
    const reactUpgradeCall = execCalls.find(
      (c) => c.cmd.includes("react@latest"),
    );
    expect(reactUpgradeCall).toBeUndefined();
  });

  it("calls exec with correct package manager for pnpm", async () => {
    setupProject(tmpDir, { router: "pages" });
    writeFile(tmpDir, "pnpm-lock.yaml", "lockfileVersion: 5");

    const { execCalls } = await runInit(tmpDir);

    const installCall = execCalls.find((c) => c.cmd.includes("add -D") || c.cmd.includes("install -D"));
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^pnpm add -D/);
  });

  it("calls exec with npm when no lock file exists", async () => {
    setupProject(tmpDir, { router: "pages" });

    const { execCalls } = await runInit(tmpDir);

    const installCall = execCalls.find((c) => c.cmd.includes("install -D") || c.cmd.includes("add -D"));
    expect(installCall).toBeDefined();
    expect(installCall!.cmd).toMatch(/^npm install -D/);
  });
});

// ─── Guard Rails ─────────────────────────────────────────────────────────────

describe("init — guard rails", () => {
  it("skips vite.config.ts when it already exists (without --force)", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir);

    expect(result.generatedViteConfig).toBe(false);
    expect(result.skippedViteConfig).toBe(true);
    // Original config should be preserved
    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toBe("export default {}");
  });

  it("still runs all other steps when vite.config.ts exists", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir);

    // Dependencies should still be installed
    expect(result.installedDeps).toContain("vite");
    // ESM migration should still happen
    expect(result.addedTypeModule).toBe(true);
    // Scripts should still be added
    expect(result.addedScripts).toContain("dev:vinext");
    expect(result.addedScripts).toContain("build:vinext");
    // But vite config should be skipped
    expect(result.generatedViteConfig).toBe(false);
    expect(result.skippedViteConfig).toBe(true);
  });

  it("overwrites vite.config.ts with --force", async () => {
    setupProject(tmpDir, { router: "app" });
    writeFile(tmpDir, "vite.config.ts", "export default {}");

    const { result } = await runInit(tmpDir, { force: true });

    expect(result.generatedViteConfig).toBe(true);
    expect(result.skippedViteConfig).toBe(false);
    const config = readFile(tmpDir, "vite.config.ts");
    expect(config).toContain("vinext()");
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
