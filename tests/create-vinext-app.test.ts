import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVinextApp } from "../packages/create-vinext-app/src/index.js";
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

const cloudflareInitOptions: ResolvedInitOptions = {
  platform: "cloudflare",
  prerender: false,
  cloudflare: {
    dataCache: "kv",
    cdnCache: "data-cache",
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
    expect(readFile(appPath, "app/page.tsx")).toContain("pnpm run dev:vinext");
    expect(readFile(appPath, "app/page.tsx")).toContain("pnpm exec vinext-cloudflare deploy");
    expect(readFile(appPath, "app/page.tsx")).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(readFile(appPath, "README.md")).toContain("pnpm run build:vinext");
    expect(readFile(appPath, "README.md")).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(readFile(appPath, "app/globals.css")).toContain('@import "tailwindcss"');
    expect(readFile(appPath, "vite.config.ts")).toContain("@cloudflare/vite-plugin");
    expect(readFile(appPath, "wrangler.jsonc")).toContain('"main": "vinext/server/fetch-handler"');
    expect(readFile(appPath, ".gitignore")).toContain(".wrangler/");

    const pkg = readPkg(appPath);
    expect(pkg.scripts).toMatchObject({
      dev: "next dev",
      build: "next build",
      start: "next start",
      "dev:vinext": "vinext dev --port 3001",
      "build:vinext": "vinext build",
      "start:vinext": "wrangler dev --config dist/server/wrangler.json",
    });
    expect(pkg.dependencies).toMatchObject({
      next: "latest",
      react: "latest",
      "react-dom": "latest",
      vinext: "latest",
      "react-server-dom-webpack": "latest",
      "@vinext/cloudflare": "latest",
    });
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

  it("uses the selected package manager through the shared init install path", async () => {
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
    expect(generatedCopy).toContain("pnpm run dev:vinext");
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
