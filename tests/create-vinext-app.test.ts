import { createServer, type ViteDevServer } from "vite-plus";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createVinextApp, runCreateVinextAppCli } from "../packages/create-vinext-app/src/index.js";
import vinext from "../packages/vinext/src/index.js";
import type { ResolvedInitOptions } from "../packages/vinext/src/init-platform.js";

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "create-vinext-app-test-"));
}

function readFile(dir: string, relativePath: string): string {
  return fs.readFileSync(path.join(dir, relativePath), "utf-8");
}

function readPkg(dir: string): {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
} {
  return JSON.parse(readFile(dir, "package.json"));
}

function linkInstalledPackage(root: string, packageName: string): void {
  const vinextRequire = createRequire(new URL("../packages/vinext/package.json", import.meta.url));
  let packageRoot =
    packageName === "vinext" || packageName === "@vinext/types"
      ? fileURLToPath(
          new URL(
            packageName === "vinext" ? "../packages/vinext" : "../packages/types",
            import.meta.url,
          ),
        )
      : packageName === "@vitejs/plugin-react"
        ? path.dirname(vinextRequire.resolve(packageName))
        : path.dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`)));
  while (!fs.existsSync(path.join(packageRoot, "package.json"))) {
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) throw new Error(`Could not find package root for ${packageName}`);
    packageRoot = parent;
  }
  const linkPath = path.join(root, "node_modules", packageName);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(packageRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function eventually(run: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

const cloudflareInitOptions: ResolvedInitOptions = {
  platform: "cloudflare",
  prerender: false,
  cloudflare: {
    dataCache: "kv",
    cdnCache: "data-cache",
    imageOptimization: "cloudflare-images",
  },
};

const warmCloudflareInitOptions: ResolvedInitOptions = {
  platform: "cloudflare",
  prerender: false,
  cloudflare: {
    dataCache: "kv",
    cdnCache: "workers-cache",
    imageOptimization: "cloudflare-images",
  },
};

const nodeInitOptions: ResolvedInitOptions = {
  platform: "node",
  prerender: false,
};

async function withQuietConsole<T>(task: () => Promise<T>): Promise<T> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return await task();
  } finally {
    logSpy.mockRestore();
  }
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createVinextApp", () => {
  it("creates a fixed App Router TypeScript Tailwind template and applies Cloudflare init", async () => {
    const appPath = path.join(tmpDir, "fresh-app");

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "npm",
        install: false,
        git: false,
        initOptions: cloudflareInitOptions,
      }),
    );

    expect(fs.existsSync(path.join(appPath, "app/page.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(appPath, "src"))).toBe(false);
    expect(readFile(appPath, "app/page.tsx")).toContain("vinext + Cloudflare Workers");
    expect(readFile(appPath, "app/page.tsx")).toContain("pnpm run dev");
    expect(readFile(appPath, "app/page.tsx")).toContain("pnpm run deploy");
    expect(readFile(appPath, "app/page.tsx")).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(readFile(appPath, "README.md")).toContain("pnpm run build");
    expect(readFile(appPath, "README.md")).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(readFile(appPath, "app/globals.css")).toContain('@import "tailwindcss"');
    expect(readFile(appPath, "vite.config.ts")).toContain("@cloudflare/vite-plugin");
    expect(readFile(appPath, "wrangler.jsonc")).toContain('"main": "vinext/server/fetch-handler"');
    expect(readFile(appPath, ".gitignore")).toContain(".wrangler/");
    expect(readFile(appPath, ".gitignore")).toContain("next-env.d.ts");
    expect(fs.existsSync(path.join(appPath, "next-env.d.ts"))).toBe(false);

    const tsconfig = JSON.parse(readFile(appPath, "tsconfig.json")) as {
      compilerOptions: { types: string[] };
    };
    expect(tsconfig.compilerOptions.types).toEqual(["vinext/types", "node"]);

    const pkg = readPkg(appPath);
    expect(pkg.scripts).toEqual({
      dev: "vinext dev",
      build: "vinext build",
      start: "wrangler dev --config dist/server/wrangler.json",
      deploy: "vinext-cloudflare deploy --config dist/server/wrangler.json",
    });
    expect(pkg.dependencies).toMatchObject({
      react: "latest",
      "react-dom": "latest",
      vinext: "latest",
      "react-server-dom-webpack": "latest",
      "@vinext/cloudflare": "latest",
    });
    expect(pkg.dependencies).not.toHaveProperty("next");
    expect(readFile(appPath, "tsconfig.json")).not.toContain('"name": "next"');
    expect(pkg.scripts).not.toHaveProperty("postinstall");
    expect(pkg.devDependencies).toMatchObject({
      tailwindcss: "latest",
      typescript: "latest",
      vite: "latest",
      "@vitejs/plugin-react": "latest",
      "@vitejs/plugin-rsc": "latest",
      "@cloudflare/vite-plugin": "latest",
      wrangler: "latest",
    });
  });

  it("does not show the warm CDN cache deploy command by default for Workers Cache init", async () => {
    const appPath = path.join(tmpDir, "warm-app");

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "npm",
        install: false,
        git: false,
        initOptions: warmCloudflareInitOptions,
      }),
    );

    expect(readFile(appPath, "app/page.tsx")).toContain("pnpm run deploy");
    expect(readFile(appPath, "app/page.tsx")).not.toContain("--experimental-warm-cdn-cache");
    const pkg = readPkg(appPath);
    expect(pkg.scripts?.deploy).toBe("vinext-cloudflare deploy --config dist/server/wrangler.json");
  });

  it("uses the selected package manager without installing Next.js", async () => {
    const appPath = path.join(tmpDir, "install-app");
    const calls: string[] = [];

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "pnpm",
        install: true,
        git: false,
        initOptions: cloudflareInitOptions,
        _exec: (cmd) => {
          calls.push(cmd);
        },
      }),
    );

    expect(readPkg(appPath).packageManager).toMatch(/^pnpm(?:@|$)/);
    expect(calls).toContain("pnpm add vinext react-server-dom-webpack @vinext/cloudflare");
    expect(calls).toContain(
      "pnpm add -D vite @vitejs/plugin-react @vitejs/plugin-rsc @cloudflare/vite-plugin wrangler",
    );
    expect(calls.some((command) => command.split(/\s+/).includes("next"))).toBe(false);
    expect(calls.some((command) => command.includes("typegen"))).toBe(false);
  });

  it("type-checks a Next-less generated app before vinext first runs", async () => {
    const appPath = path.join(tmpDir, "typecheck-app");

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "npm",
        install: false,
        git: false,
        initOptions: nodeInitOptions,
      }),
    );

    expect(fs.existsSync(path.join(appPath, "next-env.d.ts"))).toBe(false);
    for (const packageName of [
      "vinext",
      "@vinext/types",
      "@types/node",
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "@vitejs/plugin-rsc",
      "react",
      "react-dom",
      "vite",
    ]) {
      linkInstalledPackage(appPath, packageName);
    }

    const tscPath = fileURLToPath(
      new URL("bin/tsc", import.meta.resolve("typescript/package.json")),
    );
    const result = spawnSync(process.execPath, [tscPath, "--project", "tsconfig.json"], {
      cwd: appPath,
      encoding: "utf-8",
    });
    if (result.error) throw result.error;

    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toBe("");
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(appPath, "node_modules/next"))).toBe(false);
    expect(fs.existsSync(path.join(appPath, "next-env.d.ts"))).toBe(false);
  });

  // Next.js regenerates next-env.d.ts when the dev server starts:
  // test/development/typescript-app-type-declarations/typescript-app-type-declarations.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/development/typescript-app-type-declarations/typescript-app-type-declarations.test.ts
  it("generates next-env.d.ts when vinext starts", async () => {
    const appPath = path.join(tmpDir, "dev-app");
    let server: ViteDevServer | null = null;

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "npm",
        install: false,
        git: false,
        initOptions: nodeInitOptions,
      }),
    );
    expect(fs.existsSync(path.join(appPath, "next-env.d.ts"))).toBe(false);

    try {
      server = await createServer({
        root: appPath,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext({ appDir: appPath, rsc: false })],
      });
      await eventually(async () => {
        expect(readFile(appPath, "next-env.d.ts")).toContain('import "vinext/types";');
      });
      expect(readFile(appPath, "next-env.d.ts")).toContain('import "./.next/types/routes.d.ts";');
    } finally {
      await server?.close();
    }
  });

  it("does not include Cloudflare Workers copy for the Node target", async () => {
    const appPath = path.join(tmpDir, "node-app");

    await withQuietConsole(() =>
      createVinextApp({
        appPath,
        packageManager: "npm",
        install: false,
        git: false,
        initOptions: nodeInitOptions,
      }),
    );

    const generatedCopy = ["app/api/hello/route.ts", "app/layout.tsx", "app/page.tsx", "README.md"]
      .map((file) => readFile(appPath, file))
      .join("\n");

    expect(generatedCopy).not.toMatch(/Cloudflare|Workers|Worker|Wrangler|vinext-cloudflare/);
    expect(generatedCopy).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(generatedCopy).toContain("pnpm run dev");
    expect(generatedCopy).toContain("Build Next.js-style apps with Vite.");
    expect(generatedCopy).toContain("https://vite.dev/");
    expect(fs.existsSync(path.join(appPath, "wrangler.jsonc"))).toBe(false);
    expect(readFile(appPath, "vite.config.ts")).not.toContain("@cloudflare/vite-plugin");

    const pkg = readPkg(appPath);
    expect(pkg.dependencies).toMatchObject({
      vinext: "latest",
      "react-server-dom-webpack": "latest",
    });
    expect(pkg.dependencies).not.toHaveProperty("@vinext/cloudflare");
    expect(pkg.devDependencies).not.toHaveProperty("@cloudflare/vite-plugin");
    expect(pkg.devDependencies).not.toHaveProperty("wrangler");
    expect(pkg.scripts).toEqual({
      dev: "vinext dev",
      build: "vinext build",
      start: "vinext start",
    });
  });

  it("rejects non-empty target directories", async () => {
    const appPath = path.join(tmpDir, "occupied");
    fs.mkdirSync(appPath);
    fs.writeFileSync(path.join(appPath, "file.txt"), "content", "utf-8");

    await expect(
      withQuietConsole(() =>
        createVinextApp({
          appPath,
          packageManager: "npm",
          install: false,
          git: false,
          initOptions: cloudflareInitOptions,
        }),
      ),
    ).rejects.toThrow("contains files that could conflict");
  });
});

describe("create-vinext-app CLI", () => {
  it("uses a dedicated executable entry point", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "../packages/create-vinext-app/package.json"),
        "utf-8",
      ),
    ) as { bin: Record<string, string> };

    expect(packageJson.bin).toEqual({ "create-vinext-app": "dist/cli.js" });
  });

  it("prints help through the CLI runner", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCreateVinextAppCli(["--help"]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: create-vinext-app"));
    } finally {
      logSpy.mockRestore();
    }
  });
});
